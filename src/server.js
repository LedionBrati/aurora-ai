require('dotenv').config()
const express = require('express')
const path = require('path')
const logger = require('./utils/logger')

const app = express()
const PORT = process.env.PORT || 3000

// Preserve raw body buffer for webhook signature verification
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf } }))
app.use(express.static(path.join(__dirname, '../public')))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'AI Concierge', timestamp: new Date().toISOString() })
})

app.use('/webhook/whatsapp', require('./routes/whatsapp'))
app.use('/webhook/gmail',   require('./routes/gmail'))        // Dormant locally — active on Railway via Pub/Sub
app.use('/api',             require('./routes/dashboard'))
app.use('/api/inbox',       require('./routes/inbox'))

app.get('/inbox', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/inbox.html'))
})

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'))
})

app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', err.message)
  res.status(500).json({ error: 'Internal server error' })
})

// ── Gmail polling (local dev) ─────────────────────────────────────────────
// Polls for unread emails every 30 seconds.
// On Railway, replace this with Pub/Sub: uncomment setupWatch + cron in gmail service,
// and wire the /webhook/gmail route to fetchNewMessages + processEmail.

const { fetchUnreadEmails, markAsRead } = require('./services/gmail')
const { processEmail } = require('./routes/gmail')

const serverStartTimestamp = Math.floor(Date.now() / 1000) // Unix seconds — used by Gmail `after:` filter
let isFirstPoll = true
let isPolling = false
const processedIds = new Set() // in-session dedup guard against any edge-case double-fetch

async function pollGmail() {
  if (isPolling) return
  isPolling = true
  try {
    // First poll: no time filter — catches all unread emails including old unanswered ones.
    // Every poll after: only emails that arrived after this server process started.
    const afterTimestamp = isFirstPoll ? null : serverStartTimestamp
    const messages = await fetchUnreadEmails(afterTimestamp)
    isFirstPoll = false // set after a successful fetch so a transient API error retries the catch-up

    logger.info(`Gmail poll triggered — found ${messages.length} unread message(s)`)
    for (const msg of messages) {
      if (processedIds.has(msg.id)) continue
      processedIds.add(msg.id)
      await markAsRead(msg.id) // mark before processing so a crash doesn't cause double-drafts
      await processEmail(msg)
    }
  } catch (err) {
    logger.error('Gmail poll error', err.message)
    if (err.stack) logger.error('Gmail poll stack', err.stack)
  } finally {
    isPolling = false
  }
}

app.listen(PORT, () => {
  logger.info(`AI Concierge running on port ${PORT}`)
  pollGmail()
  setInterval(pollGmail, 30_000)
})
