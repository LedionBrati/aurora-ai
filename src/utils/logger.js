function log(level, message, data) {
  const ts = new Date().toISOString()
  const prefix = `[${ts}] [${level.toUpperCase()}]`
  data !== undefined
    ? console.log(`${prefix} ${message}`, data)
    : console.log(`${prefix} ${message}`)
}

module.exports = {
  info:  (msg, data) => log('info',  msg, data),
  warn:  (msg, data) => log('warn',  msg, data),
  error: (msg, data) => log('error', msg, data),
}
