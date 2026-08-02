const { createClient } = require('@supabase/supabase-js')
const { v4: uuidv4 } = require('uuid')
const logger = require('../utils/logger')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const BUCKET = 'inbox-media'

const MIME_TO_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/3gpp': '3gp',
  'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/aac': 'aac', 'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
}

function getMediaType(mime) {
  if (!mime) return 'document'
  const base = mime.split(';')[0].trim()
  if (base.startsWith('image/')) return 'image'
  if (base.startsWith('video/')) return 'video'
  if (base.startsWith('audio/')) return 'audio'
  return 'document'
}

function getExt(mime, fallbackFilename) {
  if (fallbackFilename) {
    const parts = fallbackFilename.split('.')
    if (parts.length > 1) return parts.pop()
  }
  const base = (mime || '').split(';')[0].trim()
  return MIME_TO_EXT[base] || base.split('/')[1] || 'bin'
}

async function downloadWhatsAppMedia(mediaId) {
  const res = await fetch(`https://waba.360dialog.io/v1/media/${mediaId}`, {
    headers: { 'D360-API-KEY': process.env.WHATSAPP_API_KEY },
  })
  if (!res.ok) throw new Error(`360dialog media download failed: ${res.status}`)
  const mime = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim()
  const buffer = Buffer.from(await res.arrayBuffer())
  return { buffer, mime }
}

async function uploadToStorage(buffer, originalFilename, mime, prefix = 'whatsapp') {
  const ext  = getExt(mime, originalFilename)
  const key  = `${prefix}/${uuidv4()}.${ext}`
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(key, buffer, { contentType: mime.split(';')[0].trim(), upsert: false })
  if (error) throw new Error(`Storage upload failed: ${error.message}`)
  logger.info('media: uploaded', { key, size: buffer.length })
  return key
}

async function getSignedUrl(key, expiresIn = 3600) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(key, expiresIn)
  if (error) throw new Error(`Signed URL failed: ${error.message}`)
  return data.signedUrl
}

// Longer-lived URL for 360dialog to fetch when sending outbound media
async function getMediaLinkForSend(key) {
  return getSignedUrl(key, 86400) // 24 hours
}

module.exports = { getMediaType, getExt, downloadWhatsAppMedia, uploadToStorage, getSignedUrl, getMediaLinkForSend }
