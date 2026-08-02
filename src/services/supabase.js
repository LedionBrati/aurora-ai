const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ── Existing ──────────────────────────────────────────────────────────────

async function logInteraction(data) {
  const { error } = await supabase
    .from('guest_interactions')
    .upsert(data, { onConflict: 'email_id' })
  if (error) console.error('Supabase logInteraction error:', error.message)
  else console.log('Supabase logInteraction success:', data.email_id)
}

// ── Unified Inbox ─────────────────────────────────────────────────────────

async function upsertConversation({ channel, guestIdentifier, guestName, property, threadId, subject, lastPreview }) {
  const payload = {
    channel,
    guest_identifier: guestIdentifier,
    last_message_at: new Date().toISOString(),
  }
  if (guestName !== undefined)                              payload.guest_name            = guestName || null
  if (property !== undefined && property !== 'unknown')    payload.property              = property
  if (threadId !== undefined)                              payload.thread_id             = threadId || null
  if (subject !== undefined)                               payload.subject               = subject || null
  if (lastPreview)                                         payload.last_message_preview  = String(lastPreview).slice(0, 120)

  const { data, error } = await supabase
    .from('inbox_conversations')
    .upsert(payload, { onConflict: 'channel,guest_identifier' })
    .select()
    .single()
  if (error) throw new Error(`upsertConversation: ${error.message}`)
  return data
}

async function saveInboxMessage({ conversationId, direction, body, isDraft = false, mediaType, mediaUrl, mediaFilename, mediaMime, mediaSize }) {
  const row = { conversation_id: conversationId, direction, body, is_draft: isDraft }
  if (mediaType)     row.media_type     = mediaType
  if (mediaUrl)      row.media_url      = mediaUrl
  if (mediaFilename) row.media_filename = mediaFilename
  if (mediaMime)     row.media_mime     = mediaMime
  if (mediaSize)     row.media_size     = mediaSize

  const { data, error } = await supabase
    .from('inbox_messages')
    .insert(row)
    .select()
    .single()
  if (error) throw new Error(`saveInboxMessage: ${error.message}`)
  return data
}

async function setConversationDraft(conversationId, hasDraft) {
  const { error } = await supabase
    .from('inbox_conversations')
    .update({ has_pending_draft: hasDraft })
    .eq('id', conversationId)
  if (error) throw new Error(`setConversationDraft: ${error.message}`)
}

async function discardPendingDraft(conversationId) {
  const { error } = await supabase
    .from('inbox_messages')
    .update({ draft_discarded: true })
    .eq('conversation_id', conversationId)
    .eq('is_draft', true)
    .eq('draft_discarded', false)
  if (error) throw new Error(`discardPendingDraft: ${error.message}`)
  await setConversationDraft(conversationId, false)
}

async function getConversations() {
  const { data, error } = await supabase
    .from('inbox_conversations')
    .select('*')
    .order('last_message_at', { ascending: false })
  if (error) throw new Error(`getConversations: ${error.message}`)
  return data
}

async function getConversationById(id) {
  const { data, error } = await supabase
    .from('inbox_conversations')
    .select('*')
    .eq('id', id)
    .single()
  if (error) throw new Error(`getConversationById: ${error.message}`)
  return data
}

async function getConversationMessages(conversationId) {
  const { data, error } = await supabase
    .from('inbox_messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`getConversationMessages: ${error.message}`)
  return data
}

async function updateConversationStatus(conversationId, status) {
  const { error } = await supabase
    .from('inbox_conversations')
    .update({ status })
    .eq('id', conversationId)
  if (error) throw new Error(`updateConversationStatus: ${error.message}`)
}

async function getEmailHistory(guestEmail) {
  const { data: conv } = await supabase
    .from('inbox_conversations')
    .select('id')
    .eq('channel', 'email')
    .eq('guest_identifier', guestEmail)
    .maybeSingle()

  if (!conv) return []

  const { data: messages, error } = await supabase
    .from('inbox_messages')
    .select('direction, body, is_draft')
    .eq('conversation_id', conv.id)
    .order('created_at', { ascending: true })

  if (error) throw new Error(`getEmailHistory: ${error.message}`)

  return (messages || [])
    .filter(m => m.direction === 'inbound' || !m.is_draft)
    .map(m => ({ role: m.direction === 'inbound' ? 'guest' : 'host', message: m.body }))
}

module.exports = {
  logInteraction,
  upsertConversation,
  saveInboxMessage,
  setConversationDraft,
  discardPendingDraft,
  getConversations,
  getConversationById,
  getConversationMessages,
  updateConversationStatus,
  getEmailHistory,
}
