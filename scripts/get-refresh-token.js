require('dotenv').config()
const { google } = require('googleapis')
const http = require('http')
const url = require('url')

const PORT = 3010
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`

function checkEnv() {
  const missing = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET'].filter(k => !process.env[k])
  if (missing.length) {
    console.error(`\n  Missing in .env: ${missing.join(', ')}\n`)
    process.exit(1)
  }
}

async function main() {
  checkEnv()

  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    REDIRECT_URI
  )

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.modify'],
    prompt: 'consent', // forces Google to return a refresh token every time
  })

  console.log('\n────────────────────────────────────────────────')
  console.log('  Gmail OAuth2 — Refresh Token Setup')
  console.log('────────────────────────────────────────────────')
  console.log('\nSTEP 1 — Register this redirect URI in Google Cloud Console')
  console.log('  (if you haven\'t already):')
  console.log(`\n    ${REDIRECT_URI}\n`)
  console.log('  Go to: Cloud Console → APIs & Services → Credentials')
  console.log('  → Edit your OAuth 2.0 Client ID → Authorized redirect URIs → Add URI\n')
  console.log('────────────────────────────────────────────────')
  console.log('\nSTEP 2 — Open this URL in your browser:\n')
  console.log(`  ${authUrl}\n`)
  console.log('────────────────────────────────────────────────\n')

  const code = await waitForCallback()

  console.log('Exchanging code for tokens...\n')
  const { tokens } = await client.getToken(code)

  if (!tokens.refresh_token) {
    console.error('  Google did not return a refresh token.')
    console.error('  This happens when the app was already authorized.')
    console.error('  Fix: go to https://myaccount.google.com/permissions,')
    console.error('  revoke access for your app, then run this script again.\n')
    process.exit(1)
  }

  console.log('────────────────────────────────────────────────')
  console.log('  Done — add this to your .env:')
  console.log('────────────────────────────────────────────────\n')
  console.log(`  GMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`)
}

function waitForCallback() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const { pathname, query } = url.parse(req.url, true)
      if (pathname !== '/oauth/callback') return

      res.writeHead(200, { 'Content-Type': 'text/html' })

      if (query.error) {
        res.end('<h3>Authorization failed.</h3><p>You can close this tab.</p>')
        server.close()
        return reject(new Error(`OAuth error: ${query.error}`))
      }

      res.end('<h3>Authorization successful!</h3><p>You can close this tab and return to your terminal.</p>')
      server.close()
      resolve(query.code)
    })

    server.listen(PORT, () => {
      console.log(`Waiting for browser redirect on port ${PORT}...`)
    })
    server.on('error', reject)
  })
}

main().catch(err => {
  console.error(`\n  Error: ${err.message}\n`)
  process.exit(1)
})
