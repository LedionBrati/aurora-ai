# Aurora AI

An AI concierge for holiday rental hosts. It reads guest messages from WhatsApp and Gmail and drafts a reply for the host to check and send.

## Why I built it

I grew up in Santorini, and I build AI tools for hospitality businesses there.

Small hosts with a few properties answer the same guest questions all day, across WhatsApp and email. Check-in time, parking, how to get from the port. Most of the answers already exist somewhere, in the host's head or in a doc.

I wanted an agent that does the first draft, while the host stays in control.

So the one rule is: **every reply is a draft.** Nothing is ever sent to a guest automatically. The host reads it, edits it, and presses send.

## How it works

```
WhatsApp ─┐
          ├─► 1. FILTER  is this a real guest, or spam / sales / scam?
Gmail ────┘        ↓
              2. ROUTE   which property is it about?
                   ↓
              3. DRAFT   write a reply using that property's info
                   ↓
              Inbox      the host reviews, edits, sends
```

Each step is its own small LLM call (OpenAI `gpt-4o`) with its own prompt file in `prompts/`. So I can fix one step without touching the others.

Each property has a markdown file in `knowledge_base/` with its rules, directions and FAQs. The router picks a property, and the drafter only gets that property's file.

Everything is saved in Supabase and shows up in one inbox page for both channels.

## Key decisions

- **Drafts, not auto-replies.** A wrong answer to a guest costs a host more than a slow one. A human in the loop also means I can ship before the agent is perfect.
- **Three small steps, not one big prompt.** Spam gets thrown out before any drafting happens, and when a draft is wrong I can see which step got it wrong.
- **One file per property.** A host can edit a markdown file. No dashboard or database needed to teach the agent.
- **Client data never goes in git.** The repo is public, but the real property files and two of the prompts are gitignored. Only `*.example.*` files are tracked.
- **Fails closed.** The app won't start without a dashboard password of 16+ characters. If the WhatsApp webhook secret is missing, that webhook returns an error instead of accepting unsigned messages.

## What I learned

- **Public repos need a plan from day one.** Before making this repo public I found real property names hardcoded in the frontend. I rewrote it so the labels come from the data, and set up the gitignore so only example files can be committed.
- **Security order matters.** In Express, if the static file server is mounted above the login check, the dashboard is public. One line in the wrong place.
- **Never put secrets in what the AI reads.** If a door code is in the property file, the agent will happily give it to anyone who asks. The file should say *how* a guest gets the code, not the code.
- **Splitting the agent into steps made it debuggable.** When something went wrong I could test one prompt on its own.

## Run it

You need an OpenAI key, a Supabase project, and optionally a 360dialog (WhatsApp) account and Gmail OAuth credentials.

```bash
git clone https://github.com/LedionBrati/aurora-ai.git
cd aurora-ai
npm install
cp .env.example .env    # fill in your keys and a dashboard password

cp knowledge_base/demo-seaside-villas.example.md knowledge_base/demo-seaside-villas.md
cp prompts/router-prompt.example.txt prompts/router-prompt.txt
cp prompts/system-prompt.example.txt prompts/system-prompt.txt

npm run dev
```

Then open `http://localhost:3000/inbox` and log in with your dashboard user and password.

Gmail is checked every 30 seconds, no extra setup. For WhatsApp on localhost you need a tunnel like `npx ngrok http 3000`, then register that URL in 360dialog.

`node scripts/get-refresh-token.js` gets you a Gmail refresh token.

## Status

Working prototype, tested only with demo data. It has never been connected to a real guest inbox, and it is not deployed.

Next on my list: retrieval instead of putting the whole property file in the prompt, and a voice channel. I've started a voice demo locally, it's not in this repo yet.

MIT licensed.
