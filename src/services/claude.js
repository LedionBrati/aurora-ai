const { OpenAI } = require('openai')
const fs = require('fs')
const path = require('path')

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const MODEL = 'gpt-4o'
const PROMPTS_DIR = path.join(__dirname, '../../prompts')

// Load all prompts once at startup — they never change at runtime
const FILTER_PROMPT  = fs.readFileSync(path.join(PROMPTS_DIR, 'filter-prompt.txt'),  'utf-8')
const ROUTER_PROMPT  = fs.readFileSync(path.join(PROMPTS_DIR, 'router-prompt.txt'),  'utf-8')
const SYSTEM_PROMPT  = fs.readFileSync(path.join(PROMPTS_DIR, 'system-prompt.txt'),  'utf-8')
const DRAFT_TEMPLATE = fs.readFileSync(path.join(PROMPTS_DIR, 'draft-prompt.txt'),   'utf-8')

// Returns { classification: "REAL_GUEST"|"NOT_GUEST", confidence, reason }
async function filterMessage(messageText) {
  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 200,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: FILTER_PROMPT },
      { role: 'user',   content: messageText },
    ],
  })
  return JSON.parse(response.choices[0].message.content)
}

function toMessageArray(conversationHistory) {
  return conversationHistory.map(m => ({
    role:    m.role === 'guest' ? 'user' : 'assistant',
    content: m.message,
  }))
}

// Returns { property: "<slug matching a knowledge_base/*.md file>"|"unknown", confidence, reason }
async function routeToProperty(messageText, conversationHistory = []) {
  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 200,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: ROUTER_PROMPT },
      ...toMessageArray(conversationHistory),
      { role: 'user',   content: messageText },
    ],
  })
  return JSON.parse(response.choices[0].message.content)
}

// Returns a ready-to-send plain-text draft reply
async function generateDraft(messageText, knowledgeBase, conversationHistory = []) {
  const userContent = DRAFT_TEMPLATE
    .replace('{KNOWLEDGE_BASE}', knowledgeBase)
    .replace('{GUEST_MESSAGE}', messageText)

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...toMessageArray(conversationHistory),
      { role: 'user',   content: userContent },
    ],
  })
  return response.choices[0].message.content
}

module.exports = { filterMessage, routeToProperty, generateDraft }
