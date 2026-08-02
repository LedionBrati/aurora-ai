const express = require('express')
const router = express.Router()
const { extractEmailContent, createDraft } = require('../services/gmail')
const { filterMessage, routeToProperty, generateDraft } = require('../services/claude')
const { getKnowledgeBase } = require('../services/knowledgeBase')
const { logInteraction, upsertConversation, saveInboxMessage, setConversationDraft, getEmailHistory } = require('../services/supabase')
const logger = require('../utils/logger')

const FALLBACK = 'Thank you for reaching out! One of our team will get back to you shortly.'

// Pub/Sub webhook — dormant during local dev, re-enable on Railway
router.post('/', (req, res) => {
  res.sendStatus(204)
  logger.info('Gmail webhook received — Pub/Sub not active in local dev mode')
})

async function processEmail(raw) {
  const { from, senderEmail, senderName, subject, body, threadId, messageId } = extractEmailContent(raw)

  if (!body) return
  if (senderEmail.toLowerCase() === (process.env.GMAIL_USER_EMAIL || '').toLowerCase()) return

  logger.info('Gmail: processing message', { from, subject })

  let isRealGuest = false
  let property = null
  let draftReply = null
  let draftCreated = false

  // Fetch full cross-thread history from Supabase before logging current message
  let history = []
  try { history = await getEmailHistory(senderEmail) }
  catch (err) { logger.warn('Gmail: could not fetch Supabase history', err.message) }

  // Log inbound to unified inbox (after history fetch so current message is not in its own context)
  let convId = null
  try {
    const conv = await upsertConversation({
      channel: 'email',
      guestIdentifier: senderEmail,
      guestName: senderName,
      threadId,
      subject,
      lastPreview: body,
    })
    convId = conv.id
    await saveInboxMessage({ conversationId: convId, direction: 'inbound', body })
  } catch (err) {
    logger.error('Gmail: inbox inbound log failed', err.message)
  }

  async function logDraftToInbox(draftText) {
    if (!convId) return
    try {
      await saveInboxMessage({ conversationId: convId, direction: 'outbound', body: draftText, isDraft: true })
      await setConversationDraft(convId, true)
    } catch (err) {
      logger.error('Gmail: inbox draft log failed', err.message)
    }
  }

  // Step 1 — Filter
  let filter
  try { filter = await filterMessage(body) }
  catch (err) { return logger.error('Gmail filter failed', err.message) }

  isRealGuest = filter.classification !== 'NOT_GUEST'

  if (!isRealGuest) {
    logger.info('Gmail: discarded as non-guest', { reason: filter.reason })
  } else {
    logger.info('Gmail: real guest', { confidence: filter.confidence })

    // Step 2 — Route
    let route
    try { route = await routeToProperty(body, history) }
    catch (err) {
      logger.error('Gmail router failed', err.message)
      draftCreated = await safeDraft({ to: from, subject, body: FALLBACK, threadId })
      await logDraftToInbox(FALLBACK)
      route = null
    }

    if (route) {
      property = route.property

      if (property && property !== 'unknown') {
        try { await upsertConversation({ channel: 'email', guestIdentifier: senderEmail, property }) }
        catch (err) { logger.error('Gmail: inbox property update failed', err.message) }
      }

      let knowledgeBase = null
      if (route.property !== 'unknown') {
        try { knowledgeBase = getKnowledgeBase(route.property) }
        catch (err) { logger.warn('Gmail: KB missing', { property: route.property }) }
      }

      if (!knowledgeBase) {
        logger.info('Gmail: property unknown — using fallback draft')
        draftCreated = await safeDraft({ to: from, subject, body: FALLBACK, threadId })
        await logDraftToInbox(FALLBACK)
      } else {
        // Step 3 — Generate draft
        let draft
        try { draft = await generateDraft(body, knowledgeBase, history) }
        catch (err) {
          logger.error('Gmail draft generation failed', err.message)
          draftCreated = await safeDraft({ to: from, subject, body: FALLBACK, threadId })
          await logDraftToInbox(FALLBACK)
        }

        if (draft) {
          draftReply = draft
          // Step 4 — Save to Gmail drafts + unified inbox
          draftCreated = await safeDraft({ to: from, subject, body: draft, threadId })
          await logDraftToInbox(draft)
          logger.info('Gmail: draft saved', { to: from })
        }
      }
    }
  }

  // Step 5 — Log to Supabase
  try {
    await logInteraction({
      email_id: messageId,
      thread_id: threadId,
      guest_email: senderEmail,
      guest_name: senderName || null,
      property,
      is_real_guest: isRealGuest,
      original_subject: subject,
      original_body: body,
      draft_reply: draftReply,
      draft_created: draftCreated,
    })
  } catch (err) {
    logger.error('Supabase logInteraction failed', err.message)
  }
}

async function safeDraft(params) {
  try {
    await createDraft(params)
    return true
  } catch (err) {
    logger.error('Gmail createDraft failed — retrying in 5s', err.message)
    setTimeout(async () => {
      try { await createDraft(params) }
      catch (e) { logger.error('Gmail createDraft retry also failed', e.message) }
    }, 5000)
    return false
  }
}

module.exports = router
module.exports.processEmail = processEmail
