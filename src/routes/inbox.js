const express = require('express')
const multer  = require('multer')
const router  = express.Router()
const {
  getConversations,
  getConversationById,
  getConversationMessages,
  saveInboxMessage,
  setConversationDraft,
  discardPendingDraft,
  updateConversationStatus,
} = require('../services/supabase')
const { sendMessage, sendMediaMessage, getPendingDrafts, discardDraft, appendToConversation } = require('../services/whatsapp')
const { sendEmail } = require('../services/gmail')
const { uploadToStorage, getSignedUrl, getMediaLinkForSend, getMediaType } = require('../services/media')
const logger = require('../utils/logger')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
})

// ── Conversations ─────────────────────────────────────────────────────────

router.get('/conversations', async (_req, res) => {
  try {
    res.json(await getConversations())
  } catch (err) {
    logger.error('Inbox: list failed', err.message)
    res.status(500).json({ error: 'Failed to load conversations' })
  }
})

// ── Messages (with signed URLs for media) ─────────────────────────────────

router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const messages = await getConversationMessages(req.params.id)
    for (const m of messages) {
      if (m.media_url) {
        try { m.media_signed_url = await getSignedUrl(m.media_url) }
        catch { m.media_signed_url = null }
      }
    }
    res.json(messages)
  } catch (err) {
    logger.error('Inbox: messages failed', err.message)
    res.status(500).json({ error: 'Failed to load messages' })
  }
})

// ── File upload (outbound attachments) ───────────────────────────────────

router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' })
  try {
    const { buffer, originalname, mimetype, size } = req.file
    const key = await uploadToStorage(buffer, originalname, mimetype, 'outbound')
    logger.info('Inbox: file uploaded', { key, size })
    res.json({ key, filename: originalname, mime: mimetype, size })
  } catch (err) {
    logger.error('Inbox: upload failed', err.message)
    res.status(500).json({ error: 'Upload failed' })
  }
})

// ── Reply (text or media) ─────────────────────────────────────────────────

router.post('/conversations/:id/reply', async (req, res) => {
  const { body, mediaKey, mediaFilename, mediaMime, mediaSize } = req.body
  if (!body?.trim() && !mediaKey) return res.status(400).json({ error: 'Body or media required' })

  try {
    const conv = await getConversationById(req.params.id)
    if (!conv) return res.status(404).json({ error: 'Conversation not found' })

    if (conv.channel === 'whatsapp') {
      if (mediaKey) {
        const mediaLink = await getMediaLinkForSend(mediaKey)
        const type      = getMediaType(mediaMime)
        await sendMediaMessage(conv.guest_identifier, type, mediaLink, mediaFilename, body || undefined)
      } else {
        await sendMessage(conv.guest_identifier, body)
      }
      const pending = getPendingDrafts().find(d => d.sender === conv.guest_identifier)
      if (pending) discardDraft(pending.id)
      appendToConversation(conv.guest_identifier, 'host', body || `[${getMediaType(mediaMime)}]`)
    } else if (conv.channel === 'email') {
      await sendEmail({ to: conv.guest_identifier, subject: conv.subject, body: body || '', threadId: conv.thread_id })
    }

    if (conv.has_pending_draft) await discardPendingDraft(conv.id)
    await saveInboxMessage({
      conversationId: conv.id,
      direction:      'outbound',
      body:           body || '',
      isDraft:        false,
      mediaType:      mediaKey ? getMediaType(mediaMime) : undefined,
      mediaUrl:       mediaKey  || undefined,
      mediaFilename:  mediaFilename || undefined,
      mediaMime:      mediaMime || undefined,
      mediaSize:      mediaSize  || undefined,
    })
    await setConversationDraft(conv.id, false)

    logger.info('Inbox: reply sent', { channel: conv.channel, id: conv.id, hasMedia: !!mediaKey })
    res.json({ success: true })
  } catch (err) {
    logger.error('Inbox: reply failed', err.message)
    res.status(500).json({ error: 'Failed to send reply' })
  }
})

// ── Discard draft ─────────────────────────────────────────────────────────

router.delete('/conversations/:id/draft', async (req, res) => {
  try {
    const conv = await getConversationById(req.params.id)
    if (!conv) return res.status(404).json({ error: 'Conversation not found' })
    if (conv.channel === 'whatsapp') {
      const pending = getPendingDrafts().find(d => d.sender === conv.guest_identifier)
      if (pending) discardDraft(pending.id)
    }
    await discardPendingDraft(req.params.id)
    logger.info('Inbox: draft discarded', { id: req.params.id })
    res.json({ success: true })
  } catch (err) {
    logger.error('Inbox: discard draft failed', err.message)
    res.status(500).json({ error: 'Failed to discard draft' })
  }
})

// ── Status ────────────────────────────────────────────────────────────────

router.patch('/conversations/:id/status', async (req, res) => {
  const { status } = req.body
  if (!['open', 'resolved'].includes(status)) return res.status(400).json({ error: 'Invalid status' })
  try {
    await updateConversationStatus(req.params.id, status)
    res.json({ success: true })
  } catch (err) {
    logger.error('Inbox: status update failed', err.message)
    res.status(500).json({ error: 'Failed to update status' })
  }
})

module.exports = router
