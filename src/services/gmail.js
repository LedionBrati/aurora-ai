const { google } = require('googleapis')
const logger = require('../utils/logger')

function getAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  )
  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN })
  return auth
}

function getGmailClient() {
  return google.gmail({ version: 'v1', auth: getAuth() })
}

// ── Polling ───────────────────────────────────────────────────────────────

async function fetchUnreadEmails(afterTimestamp = null) {
  const gmail = getGmailClient()
  const q = afterTimestamp
    ? `is:unread in:inbox after:${afterTimestamp}`
    : 'is:unread in:inbox'
  const listRes = await gmail.users.messages.list({ userId: 'me', q, maxResults: 10 })
  const refs = listRes.data.messages || []
  const messages = []
  for (const ref of refs) {
    const msg = await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'full' })
    messages.push(msg.data)
  }
  return messages
}

async function markAsRead(messageId) {
  const gmail = getGmailClient()
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  })
}

// ── Pub/Sub watch — re-enable when deploying to Railway ──────────────────
//
// const STATE_FILE = path.join(__dirname, '../../data/gmail-state.json')
// function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) } catch { return {} } }
// function saveState(state) { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)) }
//
// async function setupWatch() {
//   const gmail = getGmailClient()
//   const topicName = `projects/${process.env.GOOGLE_CLOUD_PROJECT_ID}/topics/${process.env.PUBSUB_TOPIC_NAME}`
//   const res = await gmail.users.watch({ userId: 'me', requestBody: { topicName, labelIds: ['INBOX'] } })
//   const state = loadState()
//   state.watchExpiration = res.data.expiration
//   if (!state.lastHistoryId) state.lastHistoryId = res.data.historyId
//   saveState(state)
//   logger.info('Gmail watch active', { expiration: res.data.expiration })
// }
//
// async function fetchNewMessages(historyId) {
//   const state = loadState()
//   const startHistoryId = state.lastHistoryId || historyId
//   const gmail = getGmailClient()
//   let history = []
//   try {
//     const res = await gmail.users.history.list({ userId: 'me', startHistoryId, historyTypes: ['messageAdded'], labelId: 'INBOX' })
//     history = res.data.history || []
//   } catch (err) {
//     if (err.code === 404) { logger.warn('Gmail: history ID expired, resetting'); state.lastHistoryId = historyId; saveState(state); return [] }
//     throw err
//   }
//   const messages = []
//   for (const record of history) {
//     for (const added of record.messagesAdded || []) {
//       const msg = await gmail.users.messages.get({ userId: 'me', id: added.message.id, format: 'full' })
//       messages.push(msg.data)
//     }
//   }
//   state.lastHistoryId = historyId
//   saveState(state)
//   return messages
// }

// ── Helpers ───────────────────────────────────────────────────────────────

// Generic: recurse MIME tree looking for a specific mimeType
function extractPartByMime(payload, mimeType) {
  if (!payload) return ''
  if (payload.mimeType === mimeType && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8')
  }
  for (const part of payload.parts || []) {
    const text = extractPartByMime(part, mimeType)
    if (text) return text
  }
  return ''
}

// Plain-text only — kept for getThreadHistory (AI prompts must not get HTML markup)
function extractTextBody(payload) {
  return extractPartByMime(payload, 'text/plain')
}

// For display: prefer HTML → fall back to plain text; returns { body, mimeType }
function extractDisplayBody(payload) {
  const html = extractPartByMime(payload, 'text/html')
  if (html) return { body: html, mimeType: 'text/html' }
  const plain = extractPartByMime(payload, 'text/plain')
  if (plain) return { body: plain, mimeType: 'text/plain' }
  return { body: '', mimeType: null }
}

function parseSender(from) {
  const match = from.match(/^(.*?)\s*<([^>]+)>$/)
  if (match) return { senderName: match[1].trim().replace(/^"|"$/g, ''), senderEmail: match[2].trim() }
  return { senderName: from.trim(), senderEmail: from.trim() }
}

function extractEmailContent(message) {
  const headers = message.payload.headers
  const getHeader = name => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''
  const from = getHeader('From')
  const { senderName, senderEmail } = parseSender(from)
  const { body, mimeType } = extractDisplayBody(message.payload)
  logger.info('Gmail: extracted body', { from: senderEmail, mimeType: mimeType || 'none', length: body.length })
  return {
    from,
    senderEmail,
    senderName,
    subject: getHeader('Subject'),
    body: body.trim(),
    threadId: message.threadId,
    messageId: message.id,
  }
}

async function getThreadHistory(threadId, currentMessageId) {
  const gmail = getGmailClient()
  const thread = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' })
  const userEmail = (process.env.GMAIL_USER_EMAIL || '').toLowerCase()
  return (thread.data.messages || [])
    .filter(m => m.id !== currentMessageId)
    .map(m => {
      const from = m.payload.headers.find(h => h.name.toLowerCase() === 'from')?.value || ''
      const { senderEmail } = parseSender(from)
      const isHost = senderEmail.toLowerCase() === userEmail
      return { role: isHost ? 'host' : 'guest', message: extractTextBody(m.payload).trim() }
    })
    .filter(m => m.message)
}

async function createDraft({ to, subject, body, threadId }) {
  const gmail = getGmailClient()
  const raw = Buffer.from(
    [`To: ${to}`, `Subject: Re: ${subject}`, 'Content-Type: text/plain; charset=utf-8', 'MIME-Version: 1.0', '', body].join('\r\n')
  ).toString('base64url')
  await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw, threadId } },
  })
  logger.info('Gmail draft created', { to, subject })
}

async function sendEmail({ to, subject, body, threadId }) {
  const gmail = getGmailClient()
  const subjectLine = subject?.startsWith('Re: ') ? subject : `Re: ${subject || 'Your inquiry'}`
  const raw = Buffer.from(
    [`To: ${to}`, `Subject: ${subjectLine}`, 'Content-Type: text/plain; charset=utf-8', 'MIME-Version: 1.0', '', body].join('\r\n')
  ).toString('base64url')
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId },
  })
  logger.info('Gmail: email sent', { to, subject: subjectLine })
}

module.exports = { fetchUnreadEmails, markAsRead, getThreadHistory, extractEmailContent, createDraft, sendEmail }
