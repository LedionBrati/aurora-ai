const crypto = require('crypto')
const logger = require('../utils/logger')

// HTTP Basic auth for the dashboard, the inbox UI, and every /api route.
//
// Why Basic: the protected surface is a browser dashboard plus the same-origin
// fetch() calls it makes. Browsers prompt for Basic credentials natively and then
// attach them to every subsequent same-origin request — including fetch — so the
// frontend needs no token handling at all.
//
// Webhook routes are NOT covered by this. They are authenticated separately by
// HMAC signature, because 360dialog and Google Pub/Sub cannot send Basic credentials.

const REALM = 'Aurora AI'

// Hash before comparing so timingSafeEqual always gets equal-length buffers
// (it throws otherwise, and the length itself would leak the secret's length).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

// Called once at startup. Refuses to boot rather than silently serving guest data
// to anyone — a missing password must never degrade into "no auth".
function assertAuthConfigured() {
  const user = process.env.DASHBOARD_USER
  const pass = process.env.DASHBOARD_PASSWORD

  if (!user || !pass) {
    console.error(`
  ────────────────────────────────────────────────────────────
   REFUSING TO START — dashboard credentials are not set.

   The inbox exposes real guest conversations and can send
   messages as the business, so it is never served unprotected.

   Add these to your .env:

     DASHBOARD_USER=admin
     DASHBOARD_PASSWORD=${crypto.randomBytes(24).toString('base64url')}

   (that password was generated fresh for you — use it or your own)
  ────────────────────────────────────────────────────────────
`)
    process.exit(1)
  }

  if (pass.length < 16) {
    console.error(`\n  REFUSING TO START — DASHBOARD_PASSWORD is too short ` +
                  `(${pass.length} chars, minimum 16).\n`)
    process.exit(1)
  }
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''

  if (!header.startsWith('Basic ')) return challenge(res)

  let decoded
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  } catch {
    return challenge(res)
  }

  // Split on the first colon only — passwords may legitimately contain colons.
  const sep = decoded.indexOf(':')
  if (sep === -1) return challenge(res)

  const user = decoded.slice(0, sep)
  const pass = decoded.slice(sep + 1)

  // Always evaluate both comparisons — no short-circuit, so a wrong username
  // costs the same time as a wrong password.
  const userOk = safeEqual(user, process.env.DASHBOARD_USER)
  const passOk = safeEqual(pass, process.env.DASHBOARD_PASSWORD)

  if (userOk && passOk) return next()

  logger.warn(`Auth: rejected ${req.method} ${req.originalUrl} from ${req.ip}`)
  return challenge(res)
}

function challenge(res) {
  // charset tells the browser to send UTF-8 credentials rather than latin-1.
  res.set('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`)
  return res.status(401).json({ error: 'Authentication required' })
}

module.exports = { requireAuth, assertAuthConfigured }
