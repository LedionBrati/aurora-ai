const express = require('express')
const router = express.Router()
const { loadDrafts, getPendingDrafts, sendMessage, markSent, discardDraft } = require('../services/whatsapp')
const logger = require('../utils/logger')

router.get('/drafts', (_req, res) => {
  res.json(getPendingDrafts())
})

router.post('/drafts/:id/send', async (req, res) => {
  const draft = loadDrafts().find(d => d.id === req.params.id && d.status === 'pending')
  if (!draft) return res.status(404).json({ error: 'Draft not found' })

  try {
    await sendMessage(draft.sender, draft.draftReply)
    const updated = markSent(req.params.id)
    logger.info('Dashboard: draft sent', { id: req.params.id, to: draft.sender })
    res.json({ success: true, draft: updated })
  } catch (err) {
    logger.error('Dashboard: send failed', err.message)
    res.status(500).json({ error: 'Failed to send message via 360dialog' })
  }
})

router.delete('/drafts/:id', (req, res) => {
  const draft = discardDraft(req.params.id)
  if (!draft) return res.status(404).json({ error: 'Draft not found' })
  logger.info('Dashboard: draft discarded', { id: req.params.id })
  res.json({ success: true })
})

module.exports = router
