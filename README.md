# Aurora AI — Guest Messaging Concierge

An AI concierge for short-term rental hosts. It watches WhatsApp and Gmail for guest
messages, filters out spam, works out which property the guest is asking about, and
drafts a reply grounded in that property's knowledge base.

**Every reply is a draft.** Nothing is ever sent to a guest automatically — the host
reviews, edits, and presses send from a unified inbox.

---

## How it works

```
  WhatsApp (360dialog webhook)  ─┐
                                 ├─►  1. FILTER   real guest, or spam/B2B/scam?
  Gmail (polling / Pub/Sub)     ─┘         │
                                           ▼
                                     2. ROUTE     which property is this about?
                                           │
                                           ▼
                                     3. DRAFT     reply grounded in that
                                           │      property's knowledge base
                                           ▼
                                     Supabase  ──►  Unified inbox (host reviews)
                                                            │
                                                            ▼
                                                   Host edits and sends
```

Each stage is a separate LLM call with its own prompt file in `prompts/`, so you can
tune one stage without touching the others.

| Stage | Prompt | Output |
|---|---|---|
| Filter | `prompts/filter-prompt.txt` | `REAL_GUEST` / `NOT_GUEST` + confidence |
| Route | `prompts/router-prompt.txt` | property slug + confidence |
| Draft | `prompts/draft-prompt.txt` + `system-prompt.txt` | ready-to-send message text |

The router's `property` value must match a filename in `knowledge_base/` — returning
`"demo-seaside-villas"` loads `knowledge_base/demo-seaside-villas.md`.

---

## Stack

- **Node.js + Express** — webhook receiver, JSON API, static inbox UI
- **OpenAI `gpt-4o`** — filter, router, and drafting (`src/services/claude.js`)
- **Supabase** — conversations, messages, drafts
- **360dialog** — WhatsApp Business API, with HMAC webhook signature verification
- **Gmail API (OAuth2)** — polls every 30s locally; Pub/Sub push in production

---

## Setup

```bash
git clone https://github.com/LedionBrati/aurora-ai.git
cd aurora-ai
npm install
```

### 1. Environment

```bash
cp .env.example .env
```

Fill in `.env` — it is gitignored and must never be committed:

| Variable | Where to get it |
|---|---|
| `OPENAI_API_KEY` | platform.openai.com |
| `WHATSAPP_API_KEY` | 360dialog Hub |
| `WHATSAPP_WEBHOOK_SECRET` | 360dialog Hub — **see the security note below** |
| `WHATSAPP_PHONE_NUMBER_ID` | 360dialog Hub |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | Google Cloud Console → OAuth2 credentials |
| `GMAIL_REFRESH_TOKEN` | run `node scripts/get-refresh-token.js` |
| `GMAIL_USER_EMAIL` | the mailbox to monitor |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Supabase project settings |

`SUPABASE_SERVICE_KEY` is the **service role** key — it bypasses row-level security.
Server-side only. Never expose it to the browser.

### 2. Configuring your properties

Real property content is deliberately kept out of git. Property knowledge bases contain
house rules, access procedures, and sometimes staff names — client material that does not
belong in a shared repo. `.gitignore` tracks only the `*.example.*` files.

Copy each example and edit in place:

```bash
cp knowledge_base/demo-seaside-villas.example.md knowledge_base/your-property.md
cp prompts/router-prompt.example.txt            prompts/router-prompt.txt
cp prompts/system-prompt.example.txt            prompts/system-prompt.txt
```

Then list your real properties in `prompts/router-prompt.txt`, making sure each slug
matches a `knowledge_base/<slug>.md` filename.

> **Do not put door codes, WiFi passwords, or lockbox combinations in a knowledge base.**
> The agent will repeat anything it finds there to a guest. Describe *how* the guest
> receives the secret instead.

The app reads all four prompt files at startup with `readFileSync`, so it will not boot
until `router-prompt.txt` and `system-prompt.txt` exist.

### 3. Run

```bash
npm run dev     # nodemon
npm start       # plain node
```

Inbox at `http://localhost:3000/inbox`, drafts dashboard at `http://localhost:3000`.

For WhatsApp webhooks against localhost:

```bash
npx ngrok http 3000
# register https://<id>.ngrok-free.app/webhook/whatsapp in 360dialog Hub
```

Gmail polls locally — no tunnel needed.

---

## ⚠️ Security status

This runs locally today. **Two things must be fixed before it is exposed to the internet:**

1. **There is no authentication.** `/inbox`, `/api/*`, and `/api/inbox/*` are wide open.
   Anyone who reaches the URL can read every guest conversation and send WhatsApp
   messages as the business. Put auth in front of the dashboard and API routes before
   deploying — the webhook routes under `/webhook/*` are the only ones meant to be public.

2. **Webhook verification fails open.** `src/routes/whatsapp.js` only checks the HMAC
   signature when `WHATSAPP_WEBHOOK_SECRET` is set. If the variable is missing in
   production, unsigned requests are accepted. Set the secret, and make a missing secret
   a hard startup failure rather than a silent skip.

Handled correctly already: secrets live only in `.env`; guest data in `data/` is
gitignored; the Supabase service key is server-side only; no guest data is hardcoded
anywhere in the source.

---

## Project layout

```
src/
  server.js              Express app, static hosting, Gmail poll loop
  routes/
    whatsapp.js          360dialog webhook → filter → route → draft
    gmail.js             Gmail message processing (polled or Pub/Sub)
    inbox.js             JSON API for the unified inbox
    dashboard.js         JSON API for the drafts dashboard
  services/
    claude.js            The three LLM calls (OpenAI gpt-4o)
    knowledgeBase.js     Loads knowledge_base/<slug>.md
    supabase.js          Conversation + message + draft persistence
    whatsapp.js          Outbound WhatsApp sending
    gmail.js             Gmail API read/send
    media.js             Image and attachment handling
  utils/logger.js
prompts/                 One file per LLM stage
knowledge_base/          One markdown file per property (real ones gitignored)
public/                  index.html (drafts) and inbox.html (unified inbox)
scripts/                 get-refresh-token.js — one-off Gmail OAuth helper
```

---

## Status

Working prototype, run locally against live mailboxes. Not deployed.
