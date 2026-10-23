'use strict'
// server.js
// Quorum usage dashboard: a tiny Node server, no framework, one dependency (pg).
//
//   GET  /healthz        Railway health check (no auth, no database)
//   GET  /login          password form          POST /login   sign in
//   GET  /logout         clear the cookie
//   GET  /               the dashboard (auth required)
//   GET  /api/metrics    JSON for the dashboard (auth required)  ?days=7|30|90  &refresh=1
//   GET  /assets/*       css, js, fonts

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const PORT = Number(process.env.PORT || 3000)
const PASSWORD = process.env.DASHBOARD_PASSWORD || ''
const SECRET = process.env.SESSION_SECRET || PASSWORD
const COOKIE = 'qd_session'
const SESSION_MS = 7 * 24 * 60 * 60 * 1000
const PUBLIC = path.join(__dirname, 'public')

// ── Auth helpers ─────────────────────────────────────────────────────────────
const sha = s => crypto.createHash('sha256').update(String(s)).digest()
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex')

function passwordOk(input) {
  return PASSWORD !== '' && crypto.timingSafeEqual(sha(input), sha(PASSWORD))
}

function makeToken() {
  const exp = String(Date.now() + SESSION_MS)
  return `${exp}.${sign(exp)}`
}

function tokenOk(token) {
  if (!token || !SECRET) return false
  const [exp, mac] = token.split('.')
  if (!exp || !mac || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false
  const want = sign(exp)
  return mac.length === want.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))
}

function cookies(req) {
  const out = {}
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

const isAuthed = req => tokenOk(cookies(req)[COOKIE])
const isHttps = req => req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted
const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'

function setCookie(res, req, value, maxAgeSec) {
  const flags = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`]
  if (isHttps(req)) flags.push('Secure')
  res.setHeader('Set-Cookie', flags.join('; '))
}

// 5 wrong passwords from one IP -> locked out for 15 minutes
const attempts = new Map()
function lockedFor(ip) {
  const a = attempts.get(ip)
  return a && a.lockedUntil > Date.now() ? Math.ceil((a.lockedUntil - Date.now()) / 60_000) : 0
}
function recordFailure(ip) {
  const a = attempts.get(ip) || { count: 0, lockedUntil: 0 }
  a.count += 1
  if (a.count >= 5) { a.lockedUntil = Date.now() + 15 * 60_000; a.count = 0 }
  attempts.set(ip, a)
}

// ── Response helpers ─────────────────────────────────────────────────────────
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store',
}

function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra })
  res.end(body)
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8')
const redirect = (res, to) => { res.writeHead(302, { Location: to, ...SECURITY_HEADERS }); res.end() }

const MIME = {
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
}

function serveAsset(res, urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\/assets\//, ''))
  const file = path.join(PUBLIC, 'assets', rel)
  // stay inside public/assets
  if (!file.startsWith(path.join(PUBLIC, 'assets') + path.sep)) return send(res, 404, 'Not found', 'text/plain')
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found', 'text/plain')
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream', { 'Cache-Control': 'public, max-age=3600' })
  })
}

const read = name => fs.readFileSync(path.join(PUBLIC, name), 'utf8')
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const loginPage = (error = '') => read('login.html').replace('{{error}}', error ? `<p class="login-error" role="alert">${esc(error)}</p>` : '')

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ── Router ───────────────────────────────────────────────────────────────────
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname

  if (p === '/healthz') return send(res, 200, 'ok', 'text/plain')
  if (p.startsWith('/assets/')) return serveAsset(res, p)

  if (!PASSWORD) {
    return send(res, 503,
      '<!doctype html><meta charset="utf-8"><title>Setup needed</title><body style="font:16px system-ui;max-width:34rem;margin:15vh auto;padding:0 1rem">' +
      '<h1>One more step</h1><p>Set the <code>DASHBOARD_PASSWORD</code> variable in Railway (Service &rarr; Variables), then redeploy. ' +
      'Until it is set, the dashboard stays locked.</p></body>')
  }

  if (p === '/login' && req.method === 'GET') return isAuthed(req) ? redirect(res, '/') : send(res, 200, loginPage())

  if (p === '/login' && req.method === 'POST') {
    const ip = clientIp(req)
    const mins = lockedFor(ip)
    if (mins) return send(res, 429, loginPage(`Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`))
    let body = ''
    try { body = await readBody(req) } catch { return send(res, 413, 'Too large', 'text/plain') }
    const given = new URLSearchParams(body).get('password') || ''
    if (!passwordOk(given)) {
      recordFailure(ip)
      console.warn(`[auth] failed login from ${ip}`)
      return send(res, 401, loginPage('That password is not right.'))
    }
    attempts.delete(ip)
    setCookie(res, req, makeToken(), SESSION_MS / 1000)
    return redirect(res, '/')
  }

  if (p === '/logout') { setCookie(res, req, '', 0); return redirect(res, '/login') }

  // everything below needs a session
  if (!isAuthed(req)) {
    return p.startsWith('/api/') ? json(res, 401, { error: 'Not signed in' }) : redirect(res, '/login')
  }

  if (p === '/' || p === '/index.html') return send(res, 200, read('index.html'))

  if (p === '/api/metrics') {
    if (!process.env.DATABASE_URL) return json(res, 503, { error: 'DATABASE_URL is not set in Railway Variables.' })
    const { getMetrics, resolveRange } = require('./lib/metrics')
    let range
    try {
      range = resolveRange({ days: url.searchParams.get('days'), from: url.searchParams.get('from'), to: url.searchParams.get('to') })
    } catch (e) { return json(res, 400, { error: e.message }) }
    try {
      const data = await getMetrics(range, { force: url.searchParams.get('refresh') === '1' })
      return json(res, 200, data)
    } catch (err) {
      console.error('[metrics] failed:', err.message)
      return json(res, 500, { error: 'Could not read from the database.', detail: String(err.message).slice(0, 300) })
    }
  }

  return send(res, 404, 'Not found', 'text/plain')
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('[server] unhandled:', err)
    if (!res.headersSent) send(res, 500, 'Server error', 'text/plain')
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Quorum dashboard listening on :${PORT}`)
  if (!PASSWORD) console.warn('DASHBOARD_PASSWORD is not set: the dashboard is locked until you set it.')
  if (!process.env.DATABASE_URL) console.warn('DATABASE_URL is not set: /api/metrics will return an error.')
})

// Railway sends SIGTERM on every redeploy; finish in-flight requests and release DB connections.
function shutdown() {
  server.close(() => {
    try { require('./lib/db').getPool().end().finally(() => process.exit(0)) } catch { process.exit(0) }
  })
  setTimeout(() => process.exit(0), 8000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
