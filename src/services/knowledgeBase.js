const fs = require('fs')
const path = require('path')

const KB_DIR = path.join(__dirname, '../../knowledge_base')

function getKnowledgeBase(propertySlug) {
  const filePath = path.join(KB_DIR, `${propertySlug}.md`)
  return fs.readFileSync(filePath, 'utf-8')
}

module.exports = { getKnowledgeBase }
