const express = require('express')
const router = express.Router()
const crypto = require('crypto')
const { filterMessage, routeToProperty, generateDraft } = require('../services/claude')
const { getKnowledgeBase } = require('../services/knowledgeBase')
const { loadConversation, appendToConversation, saveDraft } = require('../services/whatsapp')
const { upsertConversation, saveInboxMessage, setConversationDraft } = require('../services/supabase')
const { downloadWhatsAppMedia, uploadToStorage, getMediaType, getExt } = require('../services/media')
const logger = require('../utils/logger')

const FALLBACK = 'Thank you for reaching out! One of our team will get back to you shortly.'

router.post('/', (req, res) => {
  // Fails closed. This endpoint must stay publicly reachable for 360dialog, so the
  // HMAC signature is the only thing standing between the pipeline and forged
  // messages. A missing secret is a misconfiguration, never a reason to skip the check.
  if (!process.env.WHATSAPP_WEBHOOK_SECRET) {
    logger.error('WhatsApp: WHATSAPP_WEBHOOK_SECRET is not set — rejecting webhook')
    return res.sendStatus(503)
  }

  const sig = req.headers['x-hub-signature-256'] || req.headers['x-360dialog-signature'] || ''
  if (!verifySignature(req.rawBody, sig)) {
    logger.warn('WhatsApp: invalid webhook signature — rejected')
    return res.sendStatus(403)
  }

  res.sendStatus(200)
  processPayload(req.body).catch(err => logger.error('WhatsApp payload error', err.message))
})

function verifySignature(rawBody, signature) {
  if (!signature) return false
  const sigHex = signature.startsWith('sha256=') ? signature.slice(7) : signature
  const expected = crypto
    .createHmac('sha256', process.env.WHATSAPP_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex')
  try {
    return crypto.timingSafeEqual(Buffer.from(sigHex, 'hex'), Buffer.from(expected, 'hex'))
  } catch { return false }
}

async function processPayload(body) {
  const messages = body?.messages
  if (!messages?.length) return
  const contacts = body?.contacts || []

  for (const msg of messages) {
    const sender     = msg.from
    const senderName = contacts.find(c => c.wa_id === sender)?.profile?.name || sender

    if (msg.type === 'text') {
      const messageText = msg.text?.body
      if (!messageText) continue
      logger.info('WhatsApp: incoming text', { sender, senderName })
      await processMessage({ sender, senderName, messageText })
    } else if (['image', 'document', 'video', 'audio'].includes(msg.type)) {
      logger.info('WhatsApp: incoming media', { sender, type: msg.type })
      await processMediaMessage({ sender, senderName, msg })
    } else {
      logger.info('WhatsApp: skipping unsupported type', { type: msg.type })
    }
  }
}

async function processMediaMessage({ sender, senderName, msg }) {
  const mediaObj = msg[msg.type]
  if (!mediaObj?.id) return logger.warn('WhatsApp: media message missing ID', { type: msg.type })

  // Upsert conversation first
  let convId = null
  try {
    const conv = await upsertConversation({
      channel: 'whatsapp',
      guestIdentifier: sender,
      guestName: senderName,
      lastPreview: `[${msg.type}]${mediaObj.caption ? ' ' + mediaObj.caption : ''}`,
    })
    convId = conv.id
  } catch (err) {
    logger.error('WhatsApp: media conv upsert failed', err.message)
    return
  }

  // Download from 360dialog → upload to Supabase Storage
  try {
    const { buffer, mime } = await downloadWhatsAppMedia(mediaObj.id)
    const resolvedMime     = mediaObj.mime_type || mime
    const originalFilename = mediaObj.filename || null
    const key              = await uploadToStorage(buffer, originalFilename, resolvedMime, 'whatsapp')
    const ext              = getExt(resolvedMime, originalFilename)
    const filename         = originalFilename || `${msg.type}.${ext}`

    await saveInboxMessage({
      conversationId: convId,
      direction:      'inbound',
      body:           mediaObj.caption || '',
      mediaType:      getMediaType(resolvedMime),
      mediaUrl:       key,
      mediaFilename:  filename,
      mediaMime:      resolvedMime,
      mediaSize:      buffer.length,
    })
    logger.info('WhatsApp: media saved', { type: msg.type, key })
  } catch (err) {
    logger.error('WhatsApp: media download/upload failed', err.message)
    // Fallback: save a placeholder so the owner sees something in the inbox
    try {
      await saveInboxMessage({
        conversationId: convId,
        direction:      'inbound',
        body:           `[${msg.type} — could not load media]`,
      })
    } catch {}
  }
}

async function processMessage({ sender, senderName, messageText }) {
  appendToConversation(sender, 'guest', messageText)
  const history = loadConversation(sender)

  // Log inbound to unified inbox
  let convId = null
  try {
    const conv = await upsertConversation({ channel: 'whatsapp', guestIdentifier: sender, guestName: senderName, lastPreview: messageText })
    convId = conv.id
    await saveInboxMessage({ conversationId: convId, direction: 'inbound', body: messageText })
  } catch (err) {
    logger.error('WhatsApp: inbox inbound log failed', err.message)
  }

  async function logDraftToInbox(draftText) {
    if (!convId) return
    try {
      await saveInboxMessage({ conversationId: convId, direction: 'outbound', body: draftText, isDraft: true })
      await setConversationDraft(convId, true)
    } catch (err) {
      logger.error('WhatsApp: inbox draft log failed', err.message)
    }
  }

  // Step 1 — Filter
  let filter
  try { filter = await filterMessage(messageText) }
  catch (err) { return logger.error('WhatsApp filter failed', err.message) }
  if (filter.classification === 'NOT_GUEST') {
    return logger.info('WhatsApp: discarded', { reason: filter.reason })
  }
  logger.info('WhatsApp: real guest', { confidence: filter.confidence })

  // Step 2 — Route
  let route
  try { route = await routeToProperty(messageText, history) }
  catch (err) {
    logger.error('WhatsApp router failed', err.message)
    saveDraft({ sender, senderName, originalMessage: messageText, property: 'unknown', draftReply: FALLBACK })
    await logDraftToInbox(FALLBACK)
    return
  }

  if (route.property && route.property !== 'unknown') {
    try { await upsertConversation({ channel: 'whatsapp', guestIdentifier: sender, property: route.property }) }
    catch (err) { logger.error('WhatsApp: inbox property update failed', err.message) }
  }

  let knowledgeBase = null
  if (route.property !== 'unknown') {
    try { knowledgeBase = getKnowledgeBase(route.property) }
    catch (err) { logger.warn('WhatsApp: KB missing', { property: route.property }) }
  }

  if (!knowledgeBase) {
    logger.info('WhatsApp: property unknown — saving fallback draft')
    saveDraft({ sender, senderName, originalMessage: messageText, property: 'unknown', draftReply: FALLBACK })
    await logDraftToInbox(FALLBACK)
    return
  }

  // Step 3 — Generate draft
  let draft
  try { draft = await generateDraft(messageText, knowledgeBase, history) }
  catch (err) {
    logger.error('WhatsApp draft generation failed', err.message)
    saveDraft({ sender, senderName, originalMessage: messageText, property: route.property, draftReply: FALLBACK })
    await logDraftToInbox(FALLBACK)
    return
  }

  // Step 4 — Save to dashboard queue + unified inbox
  saveDraft({ sender, senderName, originalMessage: messageText, property: route.property, draftReply: draft })
  await logDraftToInbox(draft)
}

module.exports = router
