const fs = require('fs')
const path = require('path')
const { v4: uuidv4 } = require('uuid')
const logger = require('../utils/logger')

const DRAFTS_FILE       = path.join(__dirname, '../../data/whatsapp-drafts.json')
const CONVERSATIONS_DIR = path.join(__dirname, '../../data/conversations')
const API_URL = 'https://waba.360dialog.io/v1/messages'

function ensureConversationsDir() {
  if (!fs.existsSync(CONVERSATIONS_DIR)) fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true })
}

function loadDrafts() {
  try { return JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf-8')) } catch { return [] }
}

function saveDrafts(drafts) {
  fs.writeFileSync(DRAFTS_FILE, JSON.stringify(drafts, null, 2))
}

function loadConversation(phoneNumber) {
  ensureConversationsDir()
  const file = path.join(CONVERSATIONS_DIR, `${phoneNumber}.json`)
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) } catch { return [] }
}

function appendToConversation(phoneNumber, role, message) {
  ensureConversationsDir()
  const file = path.join(CONVERSATIONS_DIR, `${phoneNumber}.json`)
  const history = loadConversation(phoneNumber)
  history.push({ role, message, timestamp: new Date().toISOString() })
  fs.writeFileSync(file, JSON.stringify(history, null, 2))
}

function saveDraft({ sender, senderName, originalMessage, property, draftReply }) {
  const drafts = loadDrafts()
  const draft = {
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    status: 'pending',
    sender,
    senderName,
    originalMessage,
    property,
    draftReply,
  }
  drafts.push(draft)
  saveDrafts(drafts)
  logger.info('WhatsApp: draft saved', { id: draft.id, sender })
  return draft
}

async function sendMessage(to, text) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'D360-API-KEY': process.env.WHATSAPP_API_KEY,
    },
    body: JSON.stringify({ to, type: 'text', text: { body: text } }),
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`360dialog error ${res.status}: ${errText}`)
  }
  return res.json()
}

async function sendMediaMessage(to, type, link, filename, caption) {
  const mediaPayload = { link }
  if (caption) mediaPayload.caption = caption
  if (type === 'document' && filename) mediaPayload.filename = filename

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'D360-API-KEY': process.env.WHATSAPP_API_KEY,
    },
    body: JSON.stringify({ to, type, [type]: mediaPayload }),
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`360dialog media send error ${res.status}: ${errText}`)
  }
  return res.json()
}

function markSent(draftId) {
  const drafts = loadDrafts()
  const draft = drafts.find(d => d.id === draftId)
  if (draft) {
    draft.status = 'sent'
    draft.sentAt = new Date().toISOString()
    saveDrafts(drafts)
    appendToConversation(draft.sender, 'host', draft.draftReply)
  }
  return draft
}

function discardDraft(draftId) {
  const drafts = loadDrafts()
  const draft = drafts.find(d => d.id === draftId)
  if (draft) {
    draft.status = 'discarded'
    saveDrafts(drafts)
  }
  return draft
}

function getPendingDrafts() {
  return loadDrafts().filter(d => d.status === 'pending')
}

module.exports = {
  loadDrafts, loadConversation, appendToConversation,
  saveDraft, sendMessage, sendMediaMessage, markSent, discardDraft, getPendingDrafts,
}
