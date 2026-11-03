'use strict'
// Quorum usage dashboard: fetches /api/metrics and renders it.
// All DOM is built with textContent (never innerHTML): values such as UTM sources are user-controlled.

// ── tiny helpers ─────────────────────────────────────────────────────────────
const SVGNS = 'http://www.w3.org/2000/svg'
function h(tag, attrs, ...kids) { return build(document.createElement(tag), attrs, kids) }
function s(tag, attrs, ...kids) { return build(document.createElementNS(SVGNS, tag), attrs, kids) }
function build(el, attrs, kids) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k === 'class') el.setAttribute('class', v)
    else if (k === 'style') Object.assign(el.style, v)
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)))
  return el
}
const fmt = n => (n == null || Number.isNaN(n) ? '–' : Number(n).toLocaleString('en-IN'))
const pct = (a, b, d = 0) => (b ? `${((100 * a) / b).toFixed(d)}%` : '–')
const ratio = (a, b) => (b ? a / b : 0)
const inr = n => (n == null ? '–' : '₹' + Math.round(n).toLocaleString('en-IN'))
const sum = (rows, k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0)
const val = sec => (sec && sec.ok ? sec.data : null)
const rowsOf = sec => (sec && sec.ok && Array.isArray(sec.data) ? sec.data : [])
const cap = t => (t ? t[0].toUpperCase() + t.slice(1) : t)

function delta(cur, prev, days) {
  if (cur == null || prev == null) return null
  const label = ` vs previous ${days} days`
  if (prev === 0) return cur > 0 ? { t: 'new activity' + label, c: 'up' } : { t: 'no change' + label, c: 'flat' }
  const p = Math.round(((cur - prev) / prev) * 100)
  return { t: `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p)}%${label}`, c: p > 0 ? 'up' : p < 0 ? 'down' : 'flat' }
}

let PL = 'the last 30 days'
const errBox = (name, sec) => h('div', { class: 'err' }, `${name} unavailable: `, h('code', null, sec ? sec.error : 'no data'))
const empty = text => h('div', { class: 'empty' }, text)

function barRows(items, { max, fmtVal } = {}) {
  const m = max ?? Math.max(1, ...items.map(i => i.value))
  return h('div', { class: 'bars' }, items.map(i =>
    h('div', { class: 'brow' },
      h('span', { title: i.title || null }, i.label),
      h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${Math.max(i.value ? 1.5 : 0, (100 * i.value) / m)}%` } })),
      h('span', { class: 'val' }, fmtVal ? fmtVal(i) : fmt(i.value)))))
}

function splitBar(parts) {
  const total = sum(parts, 'value')
  if (!total) return empty('No data in this window.')
  const palette = ['var(--accent)', 'color-mix(in srgb, var(--accent) 45%, var(--surface))', 'var(--amber)', 'var(--muted)']
  const colorOf = (p, i) => (/^unknown$/i.test(p.label) ? 'color-mix(in srgb, var(--muted) 55%, var(--surface))' : palette[i % palette.length])
  return h('div', null,
    h('div', { class: 'split' }, parts.map((p, i) => p.value ?
      h('div', { style: { flex: `${p.value} 0 0`, background: colorOf(p, i) }, title: `${p.label}: ${fmt(p.value)}` }) : null)),
    h('div', { class: 'splitkey' }, parts.map((p, i) =>
      h('span', null, h('i', { style: { background: colorOf(p, i) } }), `${p.label} ${fmt(p.value)} (${pct(p.value, total)})`))))
}

function table(headers, rows, numCols = []) {
  return h('div', { class: 'scroll' }, h('table', null,
    h('thead', null, h('tr', null, headers.map((t, i) => h('th', { class: numCols.includes(i) ? 'num' : null }, t)))),
    h('tbody', null, rows.map(r => h('tr', null, r.map((c, i) => h('td', { class: numCols.includes(i) ? 'num' : null }, c)))))))
}

function stats(items) {
  return h('div', { class: 'stats' }, items.filter(Boolean).map(i =>
    h('div', null, h('b', null, i.v), h('span', null, i.l))))
}

function block(title, sub, ...content) {
  return h('div', { class: 'blk' }, h('h3', null, title), sub ? h('p', { class: 'sub' }, sub) : null, ...content)
}

function section(title, blurb, notes, ...body) {
  return h('section', { class: 'sec' },
    h('div', { class: 'sec-head' }, h('h2', null, title), h('p', null, blurb),
      notes ? h('details', null, h('summary', null, 'How this is counted'), h('p', null, notes)) : null),
    h('div', { class: 'sec-body' }, ...body))
}

// ── labels ───────────────────────────────────────────────────────────────────
const PERSONAS = {
  contrarian: 'The Contrarian', risk_architect: 'The Risk Architect', pattern_analyst: 'The Pattern Analyst',
  stakeholder_mirror: 'The Stakeholder Mirror', elder: 'The Elder', competitor: 'The Competitor',
  synthesis: 'Council Synthesis', decision_brief: 'Decision Brief',
}
const EVENT_LABELS = {
  landing_view: 'Landing views', decision_started: 'Started a decision', decision_checkpointed: 'Confirmed the decision',
  decision_completed: 'Completed a decision', another_decision_clicked: 'Clicked “another decision”',
  auth_prompt_seen: 'Saw the sign-in prompt', auth_started: 'Started sign-in', magic_link_requested: 'Requested a magic link',
  auth_skipped: 'Skipped sign-in', auth_completed: 'Finished sign-in',
  return_visit: 'Return visits', review_date_chosen: 'Chose a review date', habit_saved: 'Saved a habit',
  park_started: 'Started parking a decision', park_saved: 'Parked a decision', tally_seen: 'Saw the prediction tally',
  observation_seen: 'Saw an observation', install_prompt_seen: 'Saw install prompt', install_prompt_accepted: 'Accepted install',
  notification_opted_in: 'Opted in to notifications', notification_opened: 'Opened from a notification',
  notification_to_decision: 'Decided after a notification', mirror_viewed: 'Viewed the Mirror', mirror_unlocked: 'Mirror unlocked',
  paid_conversion: 'Paid conversion', gate_arm_assigned: 'Sign-in gate experiment assigned',
}
const EVENT_GROUPS = [
  ['Decision flow', ['landing_view', 'decision_started', 'decision_checkpointed', 'decision_completed', 'another_decision_clicked']],
  ['Sign-in', ['auth_prompt_seen', 'auth_started', 'magic_link_requested', 'auth_skipped', 'auth_completed']],
  ['Coming back', ['return_visit', 'review_date_chosen', 'habit_saved', 'park_started', 'park_saved', 'observation_seen', 'tally_seen',
    'install_prompt_seen', 'install_prompt_accepted', 'notification_opted_in', 'mirror_viewed']],
  ['Money', ['paid_conversion', 'mirror_unlocked']],
]
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const shortDate = (iso, opts = { day: 'numeric', month: 'short' }) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' })
const shortStamp = iso => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '–')

// ── trend chart (SVG; colours come from CSS variables so dark mode just works) ─
function trendChart(rows, lines, markers = []) {
  const W = 720, H = 230, m = { l: 38, r: 10, t: 10, b: 26 }
  const iw = W - m.l - m.r, ih = H - m.t - m.b, n = rows.length
  const rawMax = Math.max(1, ...lines.flatMap(l => rows.map(r => r[l.key] || 0)))
  const mag = Math.pow(10, Math.floor(Math.log10(rawMax))), top = Math.ceil(rawMax / mag) * mag
  const ymax = top < rawMax * 1.05 ? top + mag : top
  const x = i => m.l + (n === 1 ? iw / 2 : (i * iw) / (n - 1))
  const y = v => m.t + ih - (v / ymax) * ih
  const root = s('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Trend chart' })
  for (const f of [0, 0.5, 1]) {
    root.append(s('line', { class: 'grid', x1: m.l, x2: W - m.r, y1: y(ymax * f), y2: y(ymax * f) }),
      s('text', { x: m.l - 6, y: y(ymax * f) + 4, 'text-anchor': 'end' }, fmt(Math.round(ymax * f))))
  }
  const ticks = n <= 8 ? rows.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1]
  for (const i of ticks) root.append(s('text', { x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' }, shortDate(rows[i].day)))
  lines.forEach((l, li) => {
    const d = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r[l.key] || 0).toFixed(1)}`).join('')
    if (li === 0) root.append(s('path', { d: `${d}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`, fill: l.color, opacity: 0.12 }))
    root.append(s('path', { d, fill: 'none', stroke: l.color, 'stroke-width': 2, 'stroke-dasharray': l.dash || null, 'stroke-linejoin': 'round' }))
  })
  for (const mk of markers) {   // release markers: a dashed line on the day a change went live
    const i = rows.findIndex(r => r.day === mk.day); if (i < 0) continue
    root.append(s('line', { x1: x(i), x2: x(i), y1: m.t, y2: m.t + ih, stroke: 'var(--amber)', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }),
      s('text', { class: 'mk', x: Math.min(W - 6, x(i) + 4), y: m.t + 11, 'text-anchor': i > n * 0.7 ? 'end' : 'start' }, mk.label.slice(0, 26)))
  }
  const cross = s('line', { x1: 0, x2: 0, y1: m.t, y2: m.t + ih, stroke: 'var(--muted)', 'stroke-width': 1, opacity: 0 })
  const hit = s('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' })
  const tip = document.getElementById('tip')
  hit.addEventListener('mousemove', e => {
    const box = root.getBoundingClientRect(), px = ((e.clientX - box.left) / box.width) * W
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1))))
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', 1)
    tip.style.display = 'block'
    tip.replaceChildren(shortDate(rows[i].day, { weekday: 'short', day: 'numeric', month: 'short' }), ...lines.flatMap(l => [h('br'), `${l.label}: ${fmt(rows[i][l.key] || 0)}`]))
    tip.style.left = `${Math.min(window.innerWidth - 170, e.clientX + 14)}px`; tip.style.top = `${e.clientY + 14}px`
  })
  hit.addEventListener('mouseleave', () => { cross.setAttribute('opacity', 0); tip.style.display = 'none' })
  root.append(cross, hit)
  return h('div', null,
    h('div', { class: 'legend' }, lines.map(l => h('span', null, h('i', { style: { background: l.color } }), l.label))), root)
}

// ── sections ─────────────────────────────────────────────────────────────────
function pulse(D, days) {
  const S = D.sections, o = val(S.overview), su = val(S.signups), fl = val(S.flags)
  const access = rowsOf(S.access), gp = rowsOf(S.guest_payments).find(r => r.status === 'paid')
  const paying = access.filter(r => ['monthly', 'annual'].includes(r.access_type)).reduce((a, r) => a + r.active, 0)
  const tile = (label, fig, dl, sub) => h('div', null,
    h('div', { class: 'lbl' }, label), h('div', { class: 'fig' }, fig),
    dl ? h('div', { class: `delta ${dl.c}` }, dl.t) : null, sub ? h('div', { class: 'muted small' }, sub) : null)
  return h('div', { class: 'pulse' },
    tile('Decisions', fmt(o?.sessions_period), o && delta(o.sessions_period, o.sessions_prev, days), o && `${fmt(o.sessions_total)} all time`),
    tile('People deciding', fmt(o?.people_period), o && delta(o.people_period, o.people_prev, days),
      o && `${fmt(o.people_new_period)} new, ${fmt(o.people_period - o.people_new_period)} returning`),
    tile('New accounts', fmt(su?.period), su && delta(su.period, su.prev, days), su && `${fmt(su.total)} total, ${pct(su.google, su.total)} Google`),
    tile('Locked a decision', fl ? pct(fl.locked, fl.sessions) : '–', null, fl && `${fmt(fl.locked)} of ${fmt(fl.sessions)} decisions`),
    tile('Paid access now', S.access?.ok ? fmt(paying) : '–', null, D.mrr_estimate != null ? `about ${inr(D.mrr_estimate)} a month` : null),
    tile('Guest sessions', gp ? inr(gp.amount_period) : '–', null, gp ? `${fmt(gp.n_period)} paid in ${PL}` : null))
}

// ── The journey, in plain steps ──────────────────────────────────────────────────────────────────────────────
// Three blocks: the front door (counted in visits), each chat (counted in chats, so "% of chats started" is honest),
// and what happens after the Council. Rows built from events say when they began counting, so a young event never reads
// as a false zero.
const firstSeen = D => Object.fromEntries(rowsOf(D.sections.funnel_first_seen).map(r => [r.event, r.first_at]))
function measured(D, events) {
  const fs = firstSeen(D); let latest = null
  for (const e of events) { if (!fs[e]) return { state: 'none' }; if (!latest || fs[e] > latest) latest = fs[e] }
  return new Date(latest).getTime() > new Date(D.params.from + 'T00:00:00Z').getTime() + 86_400_000 ? { state: 'partial', since: latest.slice(0, 10) } : { state: 'full' }
}

function funRow(n, title, explain, value, base, o = {}) {
  const none = o.m && o.m.state === 'none'
  return h('div', { class: 'fun-row' + (none ? ' nodata' : '') },
    h('div', { class: 'fun-num' }, String(n)),
    h('div', { class: 'fun-main' },
      h('div', { class: 'fun-title' }, title),
      h('div', { class: 'fun-explain' }, explain),
      none ? h('div', { class: 'fun-badge' }, 'Not measured yet. It starts counting once the latest update is live.')
        : o.m && o.m.state === 'partial' ? h('div', { class: 'fun-badge' }, `Measured since ${dm(o.m.since)}, so earlier days read lower than they were.`) : null,
      o.extra ? h('div', { class: 'fun-extra' }, o.extra) : null),
    h('div', { class: 'fun-fig' },
      h('div', { class: 'fun-track' }, h('div', { class: 'fun-bar', style: { width: none || !base ? '0%' : `${Math.min(100, (100 * value) / base)}%` } })),
      h('div', { class: 'fun-count' }, none ? '–' : fmt(value), none || !base ? null : h('span', { class: 'muted' }, ` ${pct(value, base)}`)),
      o.lost > 0 && !none ? h('div', { class: 'fun-lost' }, `${fmt(o.lost)} left here`) : null))
}


// ── Where people drop off ────────────────────────────────────────────────────────────────────────────────────
// Answers one question: at which step do we lose the most people? Block 1 is the home page (visitors who never start a
// decision). Block 2 ranks the steps AFTER they start, so the biggest leak is compared like with like. A step needs at
// least MIN_N people entering before it is allowed to be called the biggest leak.
const MIN_N = 15
function dropoff(D, days) {
  const S = D.sections, v = val(S.funnel_visits), c = val(S.funnel_chain), g = rowsOf(S.gate_outcome)
  if (!v || !c) return null
  const hash = v.visitors_hash > 0
  const visits = hash ? v.visitors_hash : v.landing_views
  const visitsWord = hash ? 'different visitors' : 'visits'
  const mLanding = measured(D, ['landing_view']), mSum = measured(D, ['intake_summary_shown']), mLaunch = measured(D, ['council_launch_requested'])
  const bothNone = mSum.state === 'none' && mLaunch.state === 'none'   // neither confirm-screen event exists yet: those two steps cannot be told apart
  const confirmN = mSum.state === 'none' ? c.saved : c.summary
  const launchN = mLaunch.state === 'none' ? c.saved : c.launched
  const gateShown = sum(g, 'shown'), gatePassed = sum(g, 'continued')

  const steps = [
    { name: 'The chat', ask: 'Did they finish telling Quorum about the decision?', enter: c.started, stay: confirmN,
      left: bothNone ? 'did not get as far as pressing Convene (the confirm screen is not measured yet, so this step and the next are combined)' : 'left before the confirm screen',
      means: 'They typed a first message but gave up before the summary appeared.',
      tries: 'Look at how long each reply takes (see Speed and errors), how many questions are asked, and where chats stop.' },
    { name: 'The confirm screen', ask: 'Did they press “Convene the Council”?', enter: confirmN, stay: launchN, left: 'saw the summary but did not convene', notMeasured: bothNone,
      means: 'The chat worked, but the summary or the button did not convince them.',
      tries: 'Check the summary reads as correct and personal, and that the Convene button is obvious. Time spent on this screen is in Speed and errors.' },
    { name: 'Convene and sign-in', ask: 'Did the Council start after they pressed Convene?', enter: launchN, stay: c.council_started, left: 'pressed Convene but the Council never started',
      means: 'This is where the required sign-in sits. Look at how many reached the sign-in step and how many continued.',
      tries: gateShown ? `Of ${fmt(gateShown)} who reached the sign-in step, ${fmt(gatePassed)} (${pct(gatePassed, gateShown)}) continued. Also check errors for failed advisors.` : 'No one has reached the sign-in step yet in this period. Also check errors for failed advisors.' },
    { name: 'The Council', ask: 'Did the Council finish?', enter: c.council_started, stay: c.finished, left: 'started but did not finish',
      means: 'Advisors were slow, failed, or the person left while waiting.',
      tries: 'Check Speed and errors for advisor failures and the wait to the first advisor.' },
    { name: 'After the Council', ask: 'Did they lock in their decision?', enter: c.finished, stay: c.locked, left: 'finished the Council but did not lock a decision',
      means: 'They read the result but did not commit. Review dates and outcomes are counted separately below.',
      tries: `${fmt(c.review_set)} set a review date, ${fmt(c.record_opened)} opened their Record and ${fmt(c.outcome)} recorded an outcome. Look at what the lock and review prompts say.` },
  ].map(r => ({ ...r, gone: Math.max(0, r.enter - r.stay), share: r.enter ? Math.max(0, r.enter - r.stay) / r.enter : 0, ok: r.enter >= MIN_N && !r.notMeasured }))
  const ranked = steps.filter(r => r.ok && r.gone > 0).sort((a, b) => b.share - a.share)
  const worst = ranked[0] || null

  const row = (n, r, isLanding) => h('div', { class: 'fun-row leak' + (r.ok || isLanding ? '' : ' nodata') },
    h('div', { class: 'fun-num' }, String(n)),
    h('div', { class: 'fun-main' },
      h('div', { class: 'fun-title' }, r.name, worst && r === worst ? h('span', { class: 'chip bad' }, 'Biggest leak') : null, !r.ok && !isLanding ? h('span', { class: 'chip' }, r.notMeasured ? 'Not measured yet' : `Too few to judge (${fmt(r.enter)})`) : null),
      h('div', { class: 'fun-explain' }, r.ask),
      h('div', { class: 'fun-extra' }, r.means),
      h('div', { class: 'fun-explain', style: { marginTop: '4px' } }, h('b', null, 'To look at: '), r.tries)),
    h('div', { class: 'fun-fig' },
      h('div', { class: 'fun-track neg' }, h('div', { class: 'fun-bar neg', style: { width: `${Math.min(100, Math.round(100 * r.share))}%` } })),
      h('div', { class: 'fun-count' }, r.notMeasured || !r.enter ? '–' : pct(r.gone, r.enter), r.notMeasured ? null : h('span', { class: 'muted' }, ' left here')),
      r.notMeasured ? h('div', { class: 'muted small' }, 'Starts counting once the latest update is live.') : h('div', { class: 'muted small' }, `${fmt(r.gone)} of ${fmt(r.enter)} ${r.left}`)))

  // block 1: home page
  const started = c.started
  const startRate = visits ? started / visits : 0
  const land = { name: 'The home page', ask: 'Did visitors start a decision at all?', enter: visits, stay: started, gone: Math.max(0, visits - started), share: visits ? Math.max(0, visits - started) / visits : 0, ok: true,
    left: `${visitsWord} never typed a first message`,
    means: visits ? `${fmt(started)} chats were started from ${fmt(visits)} ${visitsWord}: about ${Math.round(100 * startRate)} in every 100 start one. If one channel starts far more than the others (see Who arrives, and on what), the home page is fine and the audience is what differs. If every channel is low, the page is not making clear what to do.`
      : 'No visits recorded in this period.',
    tries: 'Compare start rates by channel, then look at the headline, the example prompts and whether the input box is visible without scrolling on a phone.' }
  const per100 = n => (started ? Math.round((100 * n) / started) : 0)
  const summary = started >= 1 ? `Of every 100 chats started, about ${per100(confirmN)} reach the confirm screen, ${per100(c.council_started)} get a Council and ${per100(c.locked)} lock in a decision.` : null

  return section('Where people drop off', `Which step loses the most people, for ${PL}.`,
    `Block 1 divides chats started by ${hash ? 'distinct visitors (the daily visitor token is on)' : 'home page visits (a visit is not a person; turn on VISITOR_HASH_SECRET to count visitors)'}. Block 2 follows only people who started a chat, so each step is compared with the one before it. A step is only called the biggest leak once at least ${MIN_N} people entered it, because a handful of people can swing a percentage wildly. Steps that depend on newer tracking use the earlier count when the newer event is not measured yet. Testing by your own accounts is excluded.`,
    worst ? h('div', { class: 'stands' }, h('h3', null, 'The biggest leak right now'),
      h('ul', null, h('li', null, `${worst.name}: ${pct(worst.gone, worst.enter)} of the people who got there stopped (${fmt(worst.gone)} of ${fmt(worst.enter)} ${worst.left}).`), summary ? h('li', null, summary) : null))
      : h('div', { class: 'stands' }, h('h3', null, 'Too few people to name a biggest leak yet'),
        h('ul', null, h('li', null, `No step has had ${MIN_N} people enter it in this period. Widen the date range, or wait for more visitors.`), summary ? h('li', null, summary) : null)),
    block('1. Before they start', mLanding.state === 'partial' ? `Visits are measured since ${dm(mLanding.since)}.` : null, h('div', { class: 'fun' }, row('a', land, true))),
    block('2. Once they start a chat', `Counted in chats started. A step marked “too few to judge” has fewer than ${MIN_N} people in it.`, h('div', { class: 'fun' }, steps.map((r, i) => row(i + 1, r, false)))))
}

function funnel(D, days) {
  const S = D.sections, v = val(S.funnel_visits), c = val(S.funnel_chain)
  if (!v && !c) return section('The journey, step by step', 'From the front door to a finished decision.', null, errBox('Journey', S.funnel_chain), errBox('Visits', S.funnel_visits))
  const mm = e => measured(D, [e])
  const parts = []

  // ----- front door -----
  if (v) {
    const none = Math.max(0, v.consent_shown - v.consent_accepted - v.consent_rejected)
    const vis = v.visitors_hash ? `about ${fmt(v.visitors_est)} different visitors` : `${fmt(v.visitors_est)} visitors we can recognise${v.unidentified_views ? `, plus ${fmt(v.unidentified_views)} views from people we cannot tell apart` : ''}`
    parts.push(block('1. At the front door', 'Counted in visits to the home page. The percentage on “saw the cookie banner” is out of visits; on accepted, declined and did not answer it is out of banners shown.', h('div', { class: 'fun' },
      funRow('a', 'Visited the home page', 'Every time someone opened Quorum. The same person can visit more than once.', v.landing_views, v.landing_views, { extra: vis }),
      funRow('b', 'Saw the cookie banner', 'The banner asks whether Quorum may remember this browser. Without a yes, a returning visitor looks like a stranger.', v.consent_shown, v.landing_views, { m: mm('consent_shown') }),
      funRow('c', 'Accepted cookies', 'Said yes, so Quorum can recognise them next time.', v.consent_accepted, v.consent_shown, { m: mm('consent_accepted') }),
      funRow('d', 'Declined cookies', 'Said no. They can still use Quorum, but cannot be recognised later.', v.consent_rejected, v.consent_shown, { m: mm('consent_rejected') }),
      funRow('e', 'Did not answer the banner', 'Carried on without choosing. Their decisions have no identity attached.', none, v.consent_shown, { m: mm('consent_shown') }))))
  }

  // ----- inside each chat -----
  if (c) {
    const B = c.started, mSum = mm('intake_summary_shown'), mLaunch = mm('council_launch_requested'), mGate = mm('convene_gate_shown')
    // chats that dropped out between consecutive measured steps (the honest chain: start > confirm > convene > Council > finished)
    const chain = [['started', 'Started a chat', B]]
    if (mSum.state !== 'none') chain.push(['summary', 'Reached the confirm screen', c.summary])
    if (mLaunch.state !== 'none') chain.push(['launched', 'Tapped “Convene the Council”', c.launched])
    chain.push(['council_started', 'The Council started', c.council_started], ['finished', 'The Council finished', c.finished])
    const lostAt = {}, drops = []
    for (let i = 1; i < chain.length; i++) { const d = Math.max(0, chain[i - 1][2] - chain[i][2]); lostAt[chain[i][0]] = d; if (d > 0) drops.push({ from: chain[i - 1][1], to: chain[i][1], d, of: chain[i - 1][2] }) }
    const gateExtra = c.gate ? `${fmt(c.gate_passed)} of ${fmt(c.gate)} (${pct(c.gate_passed, c.gate)}) signed in and went on to the Council.` : null
    parts.push(block('2. Inside each chat', `Counted in chats. ${fmt(B)} chats were started in ${PL}; the percentages are out of that number.`, h('div', { class: 'fun' },
      funRow(1, 'Started a chat', 'Typed a first message about a decision.', B, B),
      funRow(2, 'Reached the confirm screen', 'The chat wrapped up and Quorum showed a short summary to check.', c.summary, B, { m: mSum, lost: lostAt.summary }),
      funRow(3, 'Tapped “Convene the Council”', 'Confirmed the summary and asked the six advisors to weigh in.', c.launched, B, { m: mLaunch, lost: lostAt.launched }),
      funRow(4, 'Reached the sign-in step', 'Asked to sign in just before the Council starts. Only people who were not already signed in see this.', c.gate, B, { m: mGate, extra: gateExtra }),
      funRow(5, 'The Council started', 'At least one advisor began answering.', c.council_started, B, { lost: lostAt.council_started }),
      funRow(6, 'The Council finished', 'The advisors all spoke and the summary was written.', c.finished, B, { lost: lostAt.finished }))))

    // ----- after the Council -----
    const F = Math.max(1, c.finished)
    const rate = c.rated ? `${fmt(c.rated_yes)} yes, ${fmt(c.rated_partly)} partly, ${fmt(c.rated_no)} not really.` : null
    parts.push(block('3. After the Council', `Counted in chats whose Council started. ${fmt(c.council_started)} in ${PL}; the percentages are out of that number.`, h('div', { class: 'fun' },
      funRow(7, 'Pushed back on an advisor', 'Typed a reply challenging something an advisor said.', c.pushback, c.council_started),
      funRow(8, 'Said whether it felt specific to them', 'Answered the “did this feel specific to you?” question.', c.rated, c.council_started, { m: mm('council_specificity_feedback'), extra: rate }),
      funRow(9, 'Locked in their decision', 'Recorded what they decided.', c.locked, c.council_started),
      funRow(10, 'Set a date to review it', 'Chose when Quorum should check back on how it went.', c.review_set, c.council_started),
      funRow(11, 'Opened their saved Record', 'Came back to look at the saved record of the decision.', c.record_opened, c.council_started, { m: mm('record_viewed') }),
      funRow(12, 'Recorded how it turned out', 'Came back later and said what happened.', c.outcome, c.council_started),
      funRow(13, 'Shared the record', 'Sent the record to someone else.', c.shared, c.council_started))))

    // ----- plain-language "what stands out" -----
    const notes = []
    if (drops.length) { const top = drops.sort((a, b) => b.d - a.d)[0]; notes.push(`The biggest drop is between “${top.from}” and “${top.to}”: ${fmt(top.d)} of ${fmt(top.of)} chats (${pct(top.d, top.of)}) stopped there.`) }
    if (v && v.consent_shown >= 5) notes.push(`Of ${fmt(v.consent_shown)} cookie banners shown, ${pct(v.consent_accepted, v.consent_shown)} were accepted, ${pct(v.consent_rejected, v.consent_shown)} declined and ${pct(Math.max(0, v.consent_shown - v.consent_accepted - v.consent_rejected), v.consent_shown)} were never answered.`)
    if (c.gate) notes.push(`${fmt(c.gate)} people reached the sign-in step before the Council and ${fmt(c.gate_passed)} (${pct(c.gate_passed, c.gate)}) continued.`)
    if (c.council_started >= 5) notes.push(`Of ${fmt(c.council_started)} Councils that started, ${pct(c.pushback, c.council_started)} drew a pushback, ${pct(c.locked, c.council_started)} were locked in, and ${pct(c.review_set, c.council_started)} had a review date set.`)
    if (notes.length) parts.unshift(h('div', { class: 'stands' }, h('h3', null, 'What stands out'), h('ul', null, notes.map(t => h('li', null, t)))))
  }

  return section('The journey, step by step', `Where people enter, and how far they get, for ${PL}.`,
    'Read it top to bottom. Block 1 counts visits to the home page. Blocks 2 and 3 follow each chat, so “% of chats” always means “out of the chats started” (block 2) or “out of the Councils that started” (block 3). Rows marked “not measured yet” or “measured since” depend on newer tracking, so older days read lower than they really were. Steps from the database (Council started, finished, locked) are counted for all history.',
    h('details', { class: 'words' }, h('summary', null, 'Words used here'),
      h('p', null, h('b', null, 'Chat: '), 'the conversation where someone describes a decision. ', h('b', null, 'Confirm screen: '), 'the short summary shown at the end of the chat. ',
        h('b', null, 'Council: '), 'six advisors who each respond to the decision. ', h('b', null, 'Pushback: '), 'when the person replies to challenge an advisor. ',
        h('b', null, 'Record: '), 'the saved page for a decision. ', h('b', null, 'Cookies: '), 'a small marker that lets Quorum recognise a returning browser.')),
    ...parts)
}

const markerRows = D => (D.markers || []).filter(m => m.date >= D.params.from && m.date <= D.params.to).map(m => ({ day: m.date, label: m.label }))

function growth(D, days) {
  const S = D.sections, daily = rowsOf(S.daily), ev = rowsOf(S.events_daily), su = val(S.signups)
  const merged = daily.map((r, i) => ({ ...r, landing: ev[i]?.landing }))
  const lines = [{ key: 'sessions', label: 'Decisions', color: 'var(--accent)' }, { key: 'people', label: 'People deciding', color: 'var(--ink)', dash: '5 4' },
    { key: 'signups', label: 'New accounts', color: 'var(--pos)' }]
  const utm = rowsOf(S.acq_utm), inv = val(S.acq_invites), ref = val(S.acq_referrals), vc = val(S.visitor_counter)
  return section('Growth', `Day by day for ${PL}.`,
    `Days follow the ${D.params.tz} timezone. A “person” is a signed-in user, or a browser (device id) if they never signed in; if someone decided anonymously and later signed in on the same browser they count once. Decisions made without a device id or account (cookie consent declined) are counted as decisions but not as people.`,
    block('Decisions, people and accounts', D.markers && D.markers.length ? 'Dashed lines mark releases (set in RELEASE_MARKERS).' : null, S.daily?.ok ? trendChart(merged, lines, markerRows(D)) : errBox('Daily series', S.daily)),
    h('div', { class: 'cols' },
      block('How people signed up', `Accounts created in ${PL}.`,
        su ? splitBar([{ label: 'Google', value: su.google_period }, { label: 'Magic link', value: su.magic_link_period }]) : errBox('Signups', S.signups)),
      block('Where new accounts came from', 'By signup UTM source and campaign.',
        S.acq_utm?.ok ? (utm.length ? barRows(utm.map(r => ({ label: r.campaign ? `${r.src} / ${r.campaign}` : r.src, value: r.n }))) : empty('No new accounts in this window.')) : errBox('Sources', S.acq_utm))),
    h('div', { class: 'cols' },
      block('Invites and referrals', null,
        inv || ref ? stats([inv && { v: fmt(inv.redemptions_period), l: `invite codes redeemed (${fmt(inv.redemptions)} all time)` },
          ref && { v: fmt(ref.period), l: `referred sign-ups (${fmt(ref.total)} all time, ${fmt(ref.referrers)} referrers)` }]) : errBox('Invites', S.acq_invites)),
      block('Public visitor counter', 'The “people already here” number shown on the site.',
        vc ? stats([{ v: fmt(vc.n), l: 'counter value (seeded at 150, increments on visits)' }]) : errBox('Visitor counter', S.visitor_counter))))
}


const DAILY_COLS = [
  { key: 'sessions', src: 'daily', label: 'Decisions', bar: true }, { key: 'people', src: 'daily', label: 'People', noTotal: true },
  { key: 'new_people', src: 'daily', label: 'New people' }, { key: 'council', src: 'daily', label: 'Council' }, { key: 'locked', src: 'daily', label: 'Locked' },
  { key: 'chats', src: 'chats_daily', label: 'Chats started' }, { key: 'confirmed', src: 'chats_daily', label: 'Chats confirmed' },
  { key: 'landing', src: 'events_daily', label: 'Landing views' }, { key: 'started', src: 'events_daily', label: 'Decisions started' },
  { key: 'signups', src: 'daily', label: 'New accounts' }, { key: 'sign_ins', src: 'events_daily', label: 'Sign-ins' }, { key: 'returns', src: 'events_daily', label: 'Return visits' },
  { key: 'orders', src: 'money_daily', label: 'Guest orders' }, { key: 'paid', src: 'money_daily', label: 'Guest paid' }, { key: 'revenue', src: 'money_daily', label: 'Guest ₹', money: true },
  { key: 'launched', src: 'events_daily', label: 'Convene taps' }, { key: 'gate_shown', src: 'events_daily', label: 'Sign-in step shown' }, { key: 'council_started', src: 'events_daily', label: 'Council started' },
  { key: 'paid_conv', src: 'events_daily', label: 'Paid conversions' }, { key: 'emails', src: 'emails_daily', label: 'Emails' }, { key: 'calls', src: 'ai_daily', label: 'AI calls' },
]

function dailyRows(D) {
  const S = D.sections, byDay = {}
  for (const src of new Set(DAILY_COLS.map(c => c.src))) for (const r of rowsOf(S[src])) byDay[r.day] = { ...(byDay[r.day] || { day: r.day }), ...r }
  return Object.values(byDay).sort((a, b) => (a.day < b.day ? -1 : 1))
}

function downloadCsv(D, rows) {
  const ok = c => S_OK(D, c.src)
  const cols = DAILY_COLS.filter(ok)
  const lines = [['day', ...cols.map(c => c.label)].join(',')]
  for (const r of rows) lines.push([r.day, ...cols.map(c => r[c.key] ?? '')].join(','))
  const a = h('a', { href: URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' })), download: `quorum-daily-${D.params.from}-to-${D.params.to}.csv` })
  document.body.append(a); a.click(); a.remove()
}
const S_OK = (D, src) => !!(D.sections[src] && D.sections[src].ok)

function releaseCheck(D) {
  const marks = D.markers || []
  if (!marks.length) return block('Before and after a release', null, empty('Add RELEASE_MARKERS in Railway (for example 2026-11-04:Sign-in before Council) to compare the days before and after a change.'))
  const rows = dailyRows(D)
  const blocks = marks.map(mk => {
    const before = rows.filter(r => r.day < mk.date), after = rows.filter(r => r.day >= mk.date)
    if (before.length < 3 || after.length < 3) return h('div', { class: 'empty' }, `${mk.label} (${dm(mk.date)}): pick a date range with at least 3 days on each side of this date to compare.`)
    const sum = (a, k) => a.reduce((t, r) => t + (Number(r[k]) || 0), 0)
    const per = (a, k) => (sum(a, k) / a.length).toFixed(1)
    const ratio = (a, n, d) => (sum(a, d) ? `${Math.round((100 * sum(a, n)) / sum(a, d))}%` : '–')
    return h('div', null, h('p', { class: 'sub' }, `${mk.label}, live from ${dm(mk.date)}. ${before.length} days before, ${after.length} days after.`),
      table(['', 'Before', 'After'], [
        ['Chats started per day', per(before, 'chats'), per(after, 'chats')],
        ['Convene taps per day', per(before, 'launched'), per(after, 'launched')],
        ['Councils started, out of Convene taps', ratio(before, 'council_started', 'launched'), ratio(after, 'council_started', 'launched')],
        ['Reached the sign-in step, out of Convene taps', ratio(before, 'gate_shown', 'launched'), ratio(after, 'gate_shown', 'launched')],
        ['New accounts per day', per(before, 'signups'), per(after, 'signups')]], [1, 2]))
  })
  return block('Before and after a release', 'Small numbers move around a lot, so read this as a direction, not proof.', ...blocks)
}

function daily(D) {
  const rows = dailyRows(D), failed = [...new Set(DAILY_COLS.map(c => c.src))].filter(src => !S_OK(D, src))
  const maxDec = Math.max(1, ...rows.map(r => r.sessions || 0))
  const tot = key => rows.reduce((a, r) => a + (Number(r[key]) || 0), 0)
  const cell = (r, c) => {
    if (!S_OK(D, c.src)) return h('td', { class: 'num muted' }, '–')
    const v = r[c.key] ?? 0
    const txt = c.money ? (v ? inr(v) : '·') : (v ? fmt(v) : '·')
    return h('td', { class: `num${v ? '' : ' z'}` }, txt, c.bar && v ? h('span', { class: 'mini' }, h('i', { style: { width: `${(100 * v) / maxDec}%` } })) : null)
  }
  const newest = [...rows].reverse()
  return section('Day by day', `Every day in ${PL}, newest first.`,
    `Days follow ${D.params.tz}. Each column is the sum for that calendar day. People is the number of distinct people deciding that day, so it is not added up in the total row (the same person on two days counts twice). Chats and decisions start from different tables, so they differ slightly. The first row of totals matches the numbers at the top of the page.`,
    releaseCheck(D),
    h('div', { class: 'blk' },
      h('div', { class: 'rowhead' }, h('p', { class: 'sub' }, `${rows.length} days. Zeros show as a dot.`), h('button', { class: 'btn', type: 'button', onclick: () => downloadCsv(D, rows) }, 'Download CSV')),
      rows.length ? h('div', { class: 'daily' }, h('div', { class: 'scrollbox' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Day'), DAILY_COLS.map(c => h('th', { class: 'num' }, c.label)))),
        h('tbody', null,
          h('tr', { class: 'tot' }, h('td', null, 'Total'), DAILY_COLS.map(c => h('td', { class: 'num' }, !S_OK(D, c.src) ? '–' : c.noTotal ? '' : c.money ? inr(tot(c.key)) : fmt(tot(c.key))))),
          newest.map(r => h('tr', { class: r.day === D.params.today ? 'today' : null },
            h('td', null, shortDate(r.day, { weekday: 'short', day: 'numeric', month: 'short' }), r.day === D.params.today ? h('span', { class: 'muted' }, ' (so far)') : null, (D.markers || []).filter(m => m.date === r.day).map(m => h('span', { class: 'chip rel' }, m.label.slice(0, 18)))),
            DAILY_COLS.map(c => cell(r, c)))))))) : empty('No data.'),
      failed.length ? h('p', { class: 'small muted' }, `Some columns are blank because these sources could not load: ${failed.join(', ')}.`) : null))
}

function frontDoor(D, days) {
  const S = D.sections, cov = val(S.events_coverage)
  if (!S.events_funnel?.ok) return section('The front door', 'What people do before and around a decision.', null, errBox('Events', S.events_funnel))
  const byEvent = Object.fromEntries(rowsOf(S.events_funnel).map(r => [r.event, r]))
  const seen = new Set()
  const groups = EVENT_GROUPS.map(([title, keys]) => {
    const items = keys.filter(k => byEvent[k]).map(k => { seen.add(k); return { label: EVENT_LABELS[k], value: byEvent[k].n, people: byEvent[k].people, anon: byEvent[k].unidentified } })
    return items.length ? block(title, null, barRows(items, { fmtVal: i => `${fmt(i.value)} · ${fmt(i.people)} people${i.anon ? `, ${fmt(i.anon)} unidentified` : ''}` })) : null
  })
  const other = Object.keys(byEvent).filter(k => !seen.has(k) && k !== 'gate_arm_assigned')
  const bd = rowsOf(S.events_breakdown), bdEvents = [...new Set(bd.map(r => r.event))]
  return section('The front door', `What people did in ${PL}, from first-party events.`,
    'Events only exist from the day the tracking build shipped, so a young events table makes early windows look small. “People” counts distinct signed-in users or device ids (one person is counted once even if they signed in midway). “Unidentified” events carry neither, which is how first-time visitors look before they accept cookies, so landing-page people is an undercount; use the views and the unidentified count to size it.',
    cov ? h('p', { class: 'muted small' }, `Events recorded: ${fmt(cov.n)}, from ${shortStamp(cov.first_at)} to ${shortStamp(cov.last_at)}.`) : null,
    h('div', { class: 'cols' }, groups.filter(Boolean)),
    other.length ? block('Other events', null, barRows(other.map(k => ({ label: EVENT_LABELS[k] || k, value: byEvent[k].n })))) : null,
    bdEvents.length ? h('details', null, h('summary', null, 'Break-downs by detail'),
      h('div', { class: 'cols', style: { marginTop: '14px' } }, bdEvents.map(ev =>
        block(EVENT_LABELS[ev] || ev, null, table(['Detail', 'Events'], bd.filter(r => r.event === ev).map(r => [r.k, fmt(r.n)]), [1]))))) : null)
}

function retention(D) {
  const S = D.sections, o = val(S.overview), R = Object.fromEntries(rowsOf(S.retention).map(r => [r.grp, r])), all = R.all
  const cohorts = rowsOf(S.cohorts), depth = rowsOf(S.depth)
  const cohortTable = cohorts.length ? h('div', { class: 'scroll' }, h('table', { class: 'cohort' },
    h('thead', null, h('tr', null, ['First decision week', 'People', 'Week 1', 'Week 2', 'Week 3', 'Week 4'].map((t, i) => h('th', { class: i ? 'num' : null }, t)))),
    h('tbody', null, cohorts.map(c => h('tr', null, h('td', null, `Week of ${shortDate(c.cohort)}`), h('td', { class: 'num' }, fmt(c.size)),
      [1, 2, 3, 4].map(w => {
        if (w > c.weeks_elapsed) return h('td', { class: 'num muted' }, '')
        const v = ratio(c['w' + w], c.size)
        return h('td', null, h('div', { class: 'cell', title: `${c['w' + w]} of ${c.size}`, style: { background: `color-mix(in srgb, var(--accent) ${Math.round(v * 70)}%, transparent)` } }, pct(c['w' + w], c.size)))
      })))))) : empty('No cohorts yet.')
  return section('Coming back', 'Whether people make a second, third and fourth decision.',
    'Retention is across all time, not just the selected window. “Mature” means the person’s first decision is old enough for the question to be fair (30 days for the 3rd-decision measure, 14 days for the 2nd-decision measure). Anonymous means never signed in; linked means signed in at least once. A week-N cell is empty until that week has finished.',
    all ? h('div', null, stats([
      { v: pct(all.mature30_d3, all.mature30), l: `made a 3rd decision within 30 days of their first (of ${fmt(all.mature30)} people old enough)` },
      { v: pct(all.mature14_d2, all.mature14), l: `made a 2nd decision within 14 days (of ${fmt(all.mature14)} old enough)` },
      o && { v: pct(o.dau, o.mau, 1), l: `daily over monthly active (${fmt(o.dau)} in 24h, ${fmt(o.wau)} in 7d, ${fmt(o.mau)} in 30d)` }])) : errBox('Retention', S.retention),
    all ? block('Decisions per person, all time', 'Share of people who reached each decision count.',
      table(['', 'People', '1st', '2nd', '3rd', '4th', '5th or more'],
        ['all', 'linked', 'anonymous'].filter(g => R[g]).map(g => [cap(g), fmt(R[g].d1), ...['d1', 'd2', 'd3', 'd4', 'd5'].map(k => `${fmt(R[g][k])} (${pct(R[g][k], R[g].d1)})`)]), [1, 2, 3, 4, 5, 6])) : null,
    S.repeat_gap?.ok && val(S.repeat_gap) ? (() => { const g = val(S.repeat_gap); return block('How soon the 2nd decision comes', `Of the ${fmt(g.people)} people with a decision on record, ${fmt(g.repeaters)} (${pct(g.repeaters, g.people)}) made a second one. All time. Separates a repeat in one sitting from a real return.`,
      barRows([{ label: 'Within the hour', value: g.within_hour }, { label: 'Later the same day', value: g.same_day }, { label: '1 to 7 days later', value: g.days_1_7 },
        { label: '7 to 30 days later', value: g.days_7_30 }, { label: 'More than 30 days later', value: g.days_30_plus }], { fmtVal: i => `${fmt(i.value)} (${pct(i.value, g.repeaters)})` })) })() : errBox('Time to 2nd decision', S.repeat_gap),
    block('Weekly cohorts', 'Of people whose first decision fell in a week, the share who decided again 1, 2, 3 and 4 weeks later.', S.cohorts?.ok ? cohortTable : errBox('Cohorts', S.cohorts)),
    block('How many decisions people made in this window', null,
      S.depth?.ok ? (depth.length ? barRows(depth.map(r => ({ label: `${r.bucket} decision${r.bucket === '1' ? '' : 's'}`, value: r.people })), { fmtVal: i => `${fmt(i.value)} people` }) : empty('No decisions in this window.')) : errBox('Depth', S.depth)))
}

function heatmap(rows) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0)); let max = 0
  for (const r of rows) { grid[r.dow - 1][r.hr] = r.n; max = Math.max(max, r.n) }
  const cells = [h('span'), ...Array.from({ length: 24 }, (_, i) => h('span', { class: 'h' }, i % 3 === 0 ? String(i) : ''))]
  grid.forEach((row, d) => { cells.push(h('span', { class: 'd' }, DOW[d])); row.forEach((n, hr) => cells.push(h('div', { class: 'c', title: `${DOW[d]} ${String(hr).padStart(2, '0')}:00, ${fmt(n)} decisions`, style: { opacity: n ? 0.1 + (0.9 * n) / max : 0.05 } }))) })
  return h('div', { class: 'heat' }, cells)
}

function inside(D, days) {
  const S = D.sections, fl = val(S.flags), oc = val(S.outcomes), modes = rowsOf(S.modes), pers = rowsOf(S.personas)
  const tally = key => { const m = {}; for (const r of modes) m[r[key] ?? 'unknown'] = (m[r[key] ?? 'unknown'] || 0) + r.n; return Object.entries(m).map(([label, value]) => ({ label: cap(label), value })).sort((a, b) => b.value - a.value) }
  const byPersona = {}; for (const r of pers) { const p = byPersona[r.persona] ||= { assistant: 0, user: 0 }; p[r.role] = r.n }
  const personaItems = Object.entries(byPersona).filter(([, v]) => v.assistant).map(([k, v]) => ({ label: PERSONAS[k] || k, value: v.assistant })).sort((a, b) => b.value - a.value)
  const userTurns = pers.filter(r => r.role === 'user').reduce((a, r) => a + r.n, 0)
  const score = oc && oc.total ? (oc.yes + 0.5 * oc.partially) / oc.total : null
  return section('Inside a session', `How people use a decision, for ${PL}.`,
    'Depth is “checkpoint” (stopped after confirming) or “council” (convened the advisors). Register is how the person framed the decision. Advisor counts are numbers of messages by persona; message text is never read. Confidence is the 1–10 re-rating after the synthesis. The weekday-by-hour map covers the last 90 days regardless of the window.',
    h('div', { class: 'cols' },
      block('How sessions start and go deep', null,
        S.modes?.ok ? h('div', null, h('p', { class: 'small muted' }, 'Depth'), splitBar(tally('depth')),
          h('p', { class: 'small muted' }, 'Intake'), splitBar(tally('mode')), h('p', { class: 'small muted' }, 'Register'), splitBar(tally('register'))) : errBox('Modes', S.modes)),
      block('What people do with the result', null,
        fl ? stats([{ v: pct(fl.locked, fl.sessions), l: `locked a decision (${fmt(fl.locked)})` }, { v: pct(fl.committed, fl.sessions), l: `set a commitment (${fmt(fl.committed)})` },
          { v: pct(fl.shared, fl.sessions), l: `shared a record (${fmt(fl.shared)})` }, { v: pct(fl.follow_ups, fl.sessions), l: `linked follow-ups (${fmt(fl.follow_ups)})` },
          { v: fl.avg_conf ?? '–', l: `average confidence out of 10 (${fmt(fl.n_conf)} ratings)` }, { v: fmt(fl.nudged), l: 'got a Council nudge' }]) : errBox('Behaviour', S.flags))),
    h('div', { class: 'cols' },
      block('Which advisors speak', `Advisor messages in ${PL}. ${fmt(userTurns)} messages from people.`,
        S.personas?.ok ? (personaItems.length ? barRows(personaItems) : empty('No Council messages in this window.')) : errBox('Advisors', S.personas)),
      block('Did the Council help?', 'What people said when they recorded an outcome.',
        oc ? (oc.total ? h('div', null, stats([{ v: score == null ? '–' : `${Math.round(score * 100)}%`, l: 'helpfulness (yes counts 1, partly 0.5)' }, { v: pct(oc.eligible_with_outcome, oc.eligible), l: `of completed decisions older than 30 days have an outcome (${fmt(oc.eligible_with_outcome)} of ${fmt(oc.eligible)})` }]),
          h('div', { style: { height: '12px' } }), splitBar([{ label: 'Yes', value: oc.yes }, { label: 'Partly', value: oc.partially }, { label: 'No', value: oc.no }]),
          (() => { const r = val(S.outcome_reach); return r && r.eligible ? h('div', { style: { marginTop: '14px' } }, stats([{ v: pct(r.eligible_linked, r.eligible), l: `of the ${fmt(r.eligible)} decisions due a 30-day check-in belong to signed-in people we can email` }, { v: `${pct(r.linked_with_outcome, r.eligible_linked)} vs ${pct(r.with_outcome - r.linked_with_outcome, r.eligible - r.eligible_linked)}`, l: 'have an outcome: signed-in vs not signed-in' }])) : null })()) : empty('No outcomes recorded yet.')) : errBox('Outcomes', S.outcomes))),
    block('When people decide', `Weekday and hour in ${D.params.tz}, last 90 days. Darker means more decisions.`, S.heatmap?.ok ? heatmap(rowsOf(S.heatmap)) : errBox('Heat map', S.heatmap)))
}


// ── Who arrives, and on what ──────────────────────────────────────────────────────────────────────────────────
const DEVICE_LABELS = { ios: 'iPhone / iPad', android: 'Android', desktop: 'Computer', other: 'Other', unknown: 'Not recorded' }
const INAPP_LABELS = { none: 'Normal browser', instagram: 'Instagram app', facebook: 'Facebook app', whatsapp: 'WhatsApp', linkedin: 'LinkedIn app', twitter: 'X / Twitter app', other_webview: 'Another app', unknown: 'Not recorded' }

function arrivals(D, days) {
  const S = D.sections, ch = rowsOf(S.channels), dv = rowsOf(S.devices), v = val(S.funnel_visits)
  const tagged = ch.some(r => r.source !== 'direct / unknown'), recorded = dv.some(r => r.device !== 'unknown')
  const inShare = v && v.landing_views ? v.in_app_views / v.landing_views : 0
  const googleInApp = dv.filter(r => r.in_app !== 'none' && r.in_app !== 'unknown').reduce((a, r) => a + r.google_tries, 0)
  return section('Who arrives, and on what', `Which channels bring people and which phones and apps they use, for ${PL}.`,
    'Source is the campaign tag on the link (utm_source) or, if there is none, the website that sent the visitor. “direct / unknown” means neither. Device and app come from the browser itself; only a coarse category is kept, never the raw browser string. Apps such as Instagram and Facebook open links in their own mini-browser, where Google sign-in is blocked.',
    block('Where visitors come from', 'The first campaign tags (utm_source, utm_medium, utm_campaign, utm_content) or referring website seen for each visit. Read “Started a decision” as the share of visits that typed a first message.',
      S.channels?.ok ? (ch.length ? table(['Source', 'Placement', 'Campaign', 'Post', 'Visits', 'Started a decision', 'Reached sign-in step', 'Saw a paywall', 'Paid'],
        ch.map(r => [r.source, r.medium || '–', r.campaign || '–', r.content || '–', fmt(r.views), `${fmt(r.started)}${r.views ? ` (${pct(r.started, r.views)})` : ''}`, fmt(r.gate), fmt(r.paywall), fmt(r.paid)]), [4, 5, 6, 7, 8]) : empty('Not measured yet. Sources appear once the latest update is live.')) : errBox('Channels', S.channels),
      S.channels?.ok && ch.length >= 30 ? h('p', { class: 'small muted' }, 'Showing the 30 busiest links. Narrow the date range to see the rest.') : null,
      S.channels?.ok && ch.length && !tagged ? h('p', { class: 'small muted' }, 'No campaign tags yet. Add ?utm_source=... to the links you share so each channel shows up here.') : null),
    block('Which phones and apps', 'Visits by device and the app they were opened in.',
      S.devices?.ok ? (dv.length && recorded ? h('div', null,
        inShare >= 0.05 ? h('div', { class: 'stands' }, h('ul', null, h('li', null, `${pct(v.in_app_views, v.landing_views)} of visits were opened inside another app (Instagram, Facebook, WhatsApp and similar). Google sign-in is blocked there, so people see an email option instead.${googleInApp ? ` ${fmt(googleInApp)} still tried Google from inside an app.` : ''}`))) : null,
        table(['Device', 'Opened in', 'Visits', 'Started a decision', 'Reached sign-in step', 'Tried Google', 'Tried email'],
          dv.map(r => [DEVICE_LABELS[r.device] || r.device, INAPP_LABELS[r.in_app] || r.in_app, fmt(r.views), fmt(r.started), fmt(r.gate), fmt(r.google_tries), fmt(r.email_tries)]), [2, 3, 4, 5, 6])) : empty('Not measured yet. This appears once the latest update is live.')) : errBox('Devices', S.devices)))
}

// ── Sign-in ───────────────────────────────────────────────────────────────────────────────────────────────────
const STAGE_LABELS = { convene_gate: 'Before the Council starts (required)', d1_soft: 'After the first decision (optional)', d2_earned: 'After a few decisions (optional)', d3_gate: 'Before another decision (required)', post_decision: 'After a decision' }

function signin(D, days) {
  const S = D.sections, g = rowsOf(S.gate_outcome), pr = rowsOf(S.signin_prompts)
  const shown = sum(g, 'shown'), cont = sum(g, 'continued')
  return section('Sign-in', `Whether people are willing to sign in, for ${PL}.`,
    'The sign-in step appears on the Council page, only for someone who is not signed in and whose Council has not started yet. “Continued” means at least one advisor then answered, which can only happen after signing in. Prompts across the app are matched to the same person by account or browser, so people who never accepted cookies cannot be followed and are not counted as finishing.',
    block('The sign-in step before the Council', 'The newest step. It is on by default and can be switched off with NEXT_PUBLIC_CONVENE_GATE=off.',
      S.gate_outcome?.ok ? (shown ? h('div', null, stats([{ v: fmt(shown), l: 'reached the sign-in step' }, { v: pct(cont, shown), l: `signed in and went on to the Council (${fmt(cont)})` }, { v: fmt(shown - cont), l: 'left without signing in' }]),
        h('div', { style: { height: '14px' } }),
        table(['Opened in', 'Reached it', 'Continued', 'Share who continued'], g.map(r => [INAPP_LABELS[r.in_app] || r.in_app, fmt(r.shown), fmt(r.continued), pct(r.continued, r.shown)]), [1, 2, 3])) : empty('Nobody has reached the sign-in step in this period. It appears once the latest update is live.')) : errBox('Sign-in step', S.gate_outcome)),
    block('Every sign-in prompt in the app', 'Where a sign-in card was shown, and how many of the people who saw it started and finished.',
      S.signin_prompts?.ok ? (pr.length ? table(['Where it was shown', 'People who saw it', 'Started signing in', 'Finished', 'Started of saw', 'Finished of saw'],
        pr.map(r => [STAGE_LABELS[r.stage] || r.stage, fmt(r.seen), fmt(r.started), fmt(r.signed_in), pct(r.started, r.seen), pct(r.signed_in, r.seen)]), [1, 2, 3, 4, 5]) : empty('No sign-in prompts recorded in this period.')) : errBox('Sign-in prompts', S.signin_prompts)))
}

// ── Speed and errors ──────────────────────────────────────────────────────────────────────────────────────────
const WHERE_LABELS = { chat_turn: 'A chat reply', council_advisor: 'A Council advisor', outcome_save: 'Saving how it turned out', payment_create: 'Starting a payment', payment_script: 'Loading the payment window' }
const KIND_LABELS = { ai_error: 'Server error', rate_limited: 'Too many requests', network: 'No connection', payment_failed: 'Payment failed', other: 'Other' }
const secs = ms => (ms == null ? '–' : ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`)

function reliability(D, days) {
  const S = D.sections, lat = val(S.latency), errs = rowsOf(S.client_errors)
  const hasLat = lat && (lat.api_n || lat.convene_n || lat.confirm_n)
  return section('Speed and errors', `How long people wait, and what went wrong, for ${PL}.`,
    'Waits are measured from the person’s side: from sending a message to the reply appearing. “Convene to first advisor” skips anyone who was asked to sign in, so it measures the AI, not the sign-in. Errors are failures the person experienced; each kind is capped per visit so a retry loop cannot flood the count. Both start counting once the latest update is live.',
    block('How long people wait', null,
      S.latency?.ok ? (hasLat ? stats([
        lat.api_n ? { v: secs(lat.api_p50 == null ? null : Number(lat.api_p50)), l: `typical wait for a chat reply (slowest 1 in 20: ${secs(Number(lat.api_p95))}, ${fmt(lat.api_n)} replies)` } : null,
        lat.convene_n ? { v: secs(lat.convene_p50 == null ? null : Number(lat.convene_p50) * 1000), l: `typical wait from “Convene” to the first advisor (slowest 1 in 20: ${secs(Number(lat.convene_p95) * 1000)}, ${fmt(lat.convene_n)} Councils)` } : null,
        lat.confirm_n ? { v: secs(Number(lat.confirm_p50)), l: `typical time spent on the confirm screen (${fmt(lat.confirm_n)} people)` } : null]) : empty('Not measured yet. This appears once the latest update is live.')) : errBox('Speed', S.latency)),
    block('What went wrong', 'Failures people ran into, most common first.',
      S.client_errors?.ok ? (errs.length ? table(['Where', 'What happened', 'Times', 'People or visits affected'], errs.map(r => [WHERE_LABELS[r.place] || r.place, KIND_LABELS[r.kind] || r.kind, fmt(r.n), fmt(r.affected)]), [2, 3]) : empty('No errors recorded in this period. That is good news, or tracking has not started yet.')) : errBox('Errors', S.client_errors)))
}

function features(D, days) {
  const rows = D.features
  const max = Math.max(1, ...rows.filter(r => r.ok).map(r => r.data.people_period))
  return section('Features', `Who used what in ${PL}.`,
    'People are distinct signed-in users; anonymous use cannot be attributed here. Memory facts count only accepted or edited facts, and connectors count only ones not revoked.',
    h('div', { class: 'scroll' }, h('table', null,
      h('thead', null, h('tr', null, ['Feature', 'People', '', 'Rows created', 'People all time'].map((t, i) => h('th', { class: i > 0 && i !== 2 ? 'num' : null }, t)))),
      h('tbody', null, rows.map(r => r.ok
        ? h('tr', null, h('td', null, r.label), h('td', { class: 'num' }, fmt(r.data.people_period)),
          h('td', { style: { width: '24%', paddingLeft: '14px' } }, h('div', { class: 'brow', style: { display: 'block' } }, h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${(100 * r.data.people_period) / max}%` } })))),
          h('td', { class: 'num' }, fmt(r.data.rows_period)), h('td', { class: 'num' }, fmt(r.data.people_total)))
        : h('tr', null, h('td', null, r.label), h('td', { colspan: 4 }, errBox(r.label, r))))))))
}

function revenue(D, days) {
  const S = D.sections, access = rowsOf(S.access), gp = rowsOf(S.guest_payments), src = rowsOf(S.guest_by_source)
  const bd = rowsOf(S.events_breakdown).filter(r => r.event === 'paid_conversion'), pr = D.prices
  const paid = gp.find(r => r.status === 'paid')
  return section('Revenue', 'Paid access and guest sessions.',
    'Paid access comes from the access table: monthly and annual rows count as active until they expire (this includes a 3-day grace buffer, and people who cancelled stay until expiry). The monthly figure is an estimate: monthly plans at their price plus annual plans divided by 12, using the prices below. Renewals reset the grant date, so new paid conversions are read from events instead. Guest sessions are one-time orders paid without an account.',
    h('div', { class: 'cols' },
      block('Paid access on the books', null,
        S.access?.ok ? (access.length ? table(['Type', 'Tier', 'Active', 'Founding', 'Ever'], access.map(r => [cap(r.access_type), r.tier, fmt(r.active), fmt(r.founding_active), fmt(r.total)]), [2, 3, 4]) : empty('No paid access rows yet.')) : errBox('Access', S.access)),
      block('Estimated monthly recurring revenue', null,
        h('div', null, stats([{ v: D.mrr_estimate == null ? '–' : inr(D.mrr_estimate), l: 'per month, estimated' }]),
          h('p', { class: 'small muted' }, `Prices used: monthly ${inr(pr.monthly)}, annual ${inr(pr.annual)}, founding monthly ${inr(pr.foundingMonthly)}, founding annual ${inr(pr.foundingAnnual)}. Change them with the PRICE_* variables in Railway.`)))),
    h('div', { class: 'cols' },
      block('Guest decision sessions', `Revenue in ${PL} is by payment date.`,
        S.guest_payments?.ok ? (gp.length ? h('div', null, stats([{ v: inr(paid?.amount ?? 0), l: `collected all time (${fmt(paid?.n ?? 0)} paid)` }, { v: inr(paid?.amount_period ?? 0), l: `collected in ${days} days (${fmt(paid?.n_period ?? 0)} paid)` }]),
          h('div', { style: { height: '12px' } }), table(['Status', 'Orders', 'This period'], gp.map(r => [cap(r.status), fmt(r.n), fmt(r.n_period)]), [1, 2])) : empty('No guest orders yet.')) : errBox('Guest payments', S.guest_payments)),
      block('Guest orders by source', 'UTM source on the order.',
        S.guest_by_source?.ok ? (src.length ? table(['Source', 'Orders', 'Paid'], src.map(r => [r.src, fmt(r.orders), fmt(r.paid)]), [1, 2]) : empty('None yet.')) : errBox('Sources', S.guest_by_source))),
    bd.length ? block('New paid conversions', `From events in ${PL}.`, barRows(bd.map(r => ({ label: cap(r.k), value: r.n })))) : null,
    (() => { const py = rowsOf(S.payments), fail = bd0(D, 'payment_failed')
      return block('From paywall to payment', `People who saw a paid plan, opened checkout and paid, for ${PL}.`,
        S.payments?.ok ? (py.length ? h('div', null, table(['Plan', 'Saw the plan', 'Opened checkout', 'Closed it without paying', 'Payment failed', 'Paid'], py.map(r => [cap(r.plan), fmt(r.viewed), `${fmt(r.opened)}${r.viewed ? ` (${pct(r.opened, r.viewed)})` : ''}`, fmt(r.dismissed), fmt(r.failed), fmt(r.success)]), [1, 2, 3, 4, 5]),
          fail.length ? h('p', { class: 'small muted' }, 'Why payments failed: ' + fail.map(r => `${r.k} (${fmt(r.n)})`).join(', ')) : null) : empty('Not measured yet. This appears once the latest update is live.')) : errBox('Payments', S.payments)) })(),
    (() => { const go = rowsOf(S.guest_orders), created = go.filter(r => r.event === 'guest_order_created'), paid = go.filter(r => r.event === 'guest_order_paid')
      return block('Guest orders: pressed pay, or created automatically?', 'From the page that sells the ₹299 session. “unknown” means that page is not yet telling us (it should send trigger: click or load).',
        S.guest_orders?.ok ? (go.length ? h('div', null, table(['Source', 'How the order was created', 'Orders created'], created.map(r => [r.src, r.trigger === 'click' ? 'Pressed the pay button' : r.trigger === 'load' ? 'Created when the page loaded' : 'Unknown', fmt(r.n)]), [2]),
          paid.length ? h('p', { class: 'small muted' }, 'Paid orders by source: ' + paid.map(r => `${r.src} (${fmt(r.n)})`).join(', ')) : null) : empty('Not measured yet. This appears once the latest update is live.')) : errBox('Guest orders', S.guest_orders)) })())
}
const bd0 = (D, ev) => rowsOf(D.sections.events_breakdown).filter(r => r.event === ev)

function lifecycle(D, days) {
  const S = D.sections, sent = rowsOf(S.notif_sent), bd = rowsOf(S.events_breakdown), emails = rowsOf(S.email_sent), pf = val(S.prefs), cad = rowsOf(S.cadence)
  const fromEv = ev => Object.fromEntries(bd.filter(r => r.event === ev).map(r => [r.k, r.n]))
  const opened = fromEv('notification_opened'), toDec = fromEv('notification_to_decision'), sentBy = Object.fromEntries(sent.map(r => [r.source, r.sent]))
  // the reminder emails live in the email log; their type matches the tag on their link (the review-date email is tagged review_date)
  for (const r of emails) { const k = r.email_type === 'reanalyze_review_date' ? 'review_date' : r.email_type; sentBy[k] = (sentBy[k] || 0) + r.sent }
  const outcomes = Object.fromEntries(rowsOf(S.outcome_sources).map(r => [r.source, r.n]))
  const returns = bd.filter(r => r.event === 'return_visit' && r.k !== '(none)')
  const sources = [...new Set([...Object.keys(sentBy), ...Object.keys(opened), ...Object.keys(toDec), ...Object.keys(outcomes).filter(k => !k.startsWith('('))])].filter(k => k !== '(none)')
  return section('Nudges and email', `Messages sent and what they led to, for ${PL}.`,
    'Sent comes from the notification log; opened and decided come from events when a visit arrives from a tagged link, so some sources (for example review-date emails) show opens without a sent count, and untagged links show sent only.',
    block('From message to decision', null,
      S.notif_sent?.ok ? (sources.length ? table(['Email', 'Sent', 'Opened', 'Then made a decision', 'Then recorded an outcome', 'Opened of sent'],
        sources.map(k => [k.replaceAll('_', ' '), fmt(sentBy[k]), fmt(opened[k]), fmt(toDec[k]), fmt(outcomes[k]), sentBy[k] && opened[k] ? pct(opened[k], sentBy[k], 1) : '–']), [1, 2, 3, 4, 5]) : empty('Nothing sent in this window.')) : errBox('Notifications', S.notif_sent),
      returns.length ? h('p', { class: 'small muted' }, 'Return visits that came from an email: ' + returns.map(r => `${r.k.replaceAll('_', ' ')} (${fmt(r.n)})`).join(', ')) : null),
    h('div', { class: 'cols' },
      block('Other email', 'From the email log.', S.email_sent?.ok ? (emails.length ? barRows(emails.map(r => ({ label: r.email_type.replaceAll('_', ' '), value: r.sent }))) : empty('None in this window.')) : errBox('Email log', S.email_sent)),
      block('Habit and opt-outs', pf ? `${fmt(pf.total)} people have preferences saved.` : null,
        pf ? h('div', null, stats([{ v: pct(pf.cadence_chosen, pf.total), l: 'chose a brief cadence' }, { v: pct(pf.weekly_out, pf.total), l: 'opted out of the weekly brief' },
          { v: pct(pf.daily_out, pf.total), l: 'opted out of daily nudges' }, { v: pct(pf.pattern_out, pf.total), l: 'opted out of pattern notices' }]),
          cad.length ? h('div', null, h('div', { style: { height: '12px' } }), splitBar(cad.map(r => ({ label: r.cadence.replaceAll('_', ' '), value: r.n })))) : null) : errBox('Preferences', S.prefs))))
}

function platform(D, days) {
  const S = D.sections, ai = rowsOf(S.ai_usage), ins = val(S.institutions), o = val(S.overview)
  const failing = [...Object.entries(S).filter(([, v]) => !v.ok).map(([k, v]) => [k, v.error]), ...D.features.filter(f => !f.ok).map(f => ['feature: ' + f.key, f.error])]
  return section('Platform and data health', 'Model routing, institutions, and how trustworthy the numbers are.',
    'Model routing is only recorded while tiered routing is switched on. Test accounts listed in EXCLUDE_EMAILS are removed from every number, along with the browsers they used.',
    h('div', { class: 'cols' },
      block('Which model answered', `AI calls in ${PL}.`,
        S.ai_usage?.ok ? (ai.length ? table(['Tier', 'Role', 'Target', 'Calls', 'Overrides'], ai.map(r => [r.tier, r.role, r.target, fmt(r.calls), fmt(r.overrides)]), [3, 4]) : empty('No calls logged. This stays empty unless tiered routing is on.')) : errBox('AI usage', S.ai_usage)),
      block('Institutions', null, ins ? stats([{ v: fmt(ins.institutions), l: `institutions (${fmt(ins.institutions_period)} new)` }, { v: fmt(ins.members), l: `members (${fmt(ins.members_period)} joined)` },
        { v: fmt(ins.cohorts), l: 'cohorts' }, { v: pct(ins.consented, ins.members), l: 'consented to aggregate' }]) : errBox('Institutions', S.institutions))),
    block('Data quality', null, h('div', null,
      stats([o && { v: pct(o.sessions_unattributed, o.sessions_total, 1), l: `of all decisions cannot be tied to a person (${fmt(o.sessions_unattributed)})` },
        o && { v: shortStamp(o.first_session_at), l: 'first decision on record' },
        D.exclusions.emails ? { v: `${D.exclusions.matched_users}`, l: `test accounts left out (${D.exclusions.devices} browsers)` } : { v: 'none', l: 'test accounts left out (set EXCLUDE_EMAILS to remove yours)' },
        { v: `${D.took_ms} ms`, l: 'time to compute this page' }]),
      (() => { const id = val(S.db_identity); return id && !id.bypass && id.rls_tables > 0 && !id.has_read_policy
        ? h('div', { class: 'err', style: { marginTop: '16px' } }, `The database login “${id.db_user}” is subject to Row Level Security, so tables can read as empty and every number here may be too low. Use the default postgres login, or run sql/create_readonly_role.sql.`) : null })(),
      D.exclusions.error ? h('div', { class: 'err', style: { marginTop: '16px' } }, 'Test-account exclusion failed, so these numbers include your own test activity: ', h('code', null, D.exclusions.error)) : null,
      D.exclusions.emails && !D.exclusions.error && D.exclusions.matched_users === 0 ? h('div', { class: 'err', style: { marginTop: '16px' } }, 'None of the addresses in EXCLUDE_EMAILS matched an account. Check the spelling.') : null,
      failing.length ? h('div', { style: { marginTop: '16px', display: 'grid', gap: '8px' } }, h('p', { class: 'small muted' }, `${failing.length} panel${failing.length === 1 ? '' : 's'} could not load. “does not exist” means a migration has not been run in this database; “timeout” means the database was slow, so press Refresh:`),
        failing.map(([k, e]) => h('div', { class: 'err' }, `${k}: `, h('code', null, e)))) : h('p', { class: 'small muted' }, 'Every panel loaded.'))))
}

// ── boot ─────────────────────────────────────────────────────────────────────
const app = document.getElementById('app')
const dm = iso => shortDate(iso, { day: 'numeric', month: 'short', year: 'numeric' })
let range = (() => { try { const r = JSON.parse(localStorage.getItem('qd_range')); if (r && (r.days || (r.from && r.to))) return r } catch {} return { days: 30 } })()
let inflight = 0

function render(D) {
  const days = D.params.days
  PL = D.params.custom ? `the period ${dm(D.params.from)} to ${dm(D.params.to)}` : `the last ${days} days`
  app.replaceChildren(pulse(D, days), dropoff(D, days), funnel(D, days), arrivals(D, days), growth(D, days), daily(D), signin(D, days), frontDoor(D, days), retention(D), inside(D, days), features(D, days), revenue(D, days), lifecycle(D, days), reliability(D, days), platform(D, days))
  const t = new Date(D.generated_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: D.params.tz })
  document.getElementById('stamp').textContent = `Updated ${t} ${D.params.tz.split('/').pop().replace('_', ' ')}`
  document.getElementById('from').value = D.params.from; document.getElementById('to').value = D.params.to
  document.getElementById('from').max = document.getElementById('to').max = D.params.today
}

function syncControls() {
  const custom = !!range.from
  document.querySelectorAll('#seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.custom ? custom : !custom && Number(b.dataset.days) === range.days)))
  document.getElementById('customWrap').hidden = !custom && !document.getElementById('customWrap').dataset.open
}

async function load(refresh = false) {
  const my = ++inflight
  syncControls()
  document.getElementById('stamp').textContent = 'Loading…'
  const qs = range.from ? `from=${range.from}&to=${range.to}` : `days=${range.days}`
  try {
    const res = await fetch(`/api/metrics?${qs}${refresh ? '&refresh=1' : ''}`, { credentials: 'same-origin', cache: 'no-store' })
    if (res.status === 401) return (location.href = '/login')
    const body = await res.json()
    if (my !== inflight) return
    if (!res.ok) throw new Error([body.error, body.detail].filter(Boolean).join(' '))
    render(body)
  } catch (e) {
    if (my !== inflight) return
    document.getElementById('stamp').textContent = ''
    app.replaceChildren(h('div', { class: 'sec', style: { display: 'block' } }, h('h2', null, 'Could not load the numbers'), h('p', { class: 'err' }, String(e.message || e)),
      h('p', { class: 'muted' }, 'Check DATABASE_URL in Railway Variables, then press Refresh.')))
  }
}

const save = () => localStorage.setItem('qd_range', JSON.stringify(range))
document.getElementById('seg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return
  if (b.dataset.custom) { const w = document.getElementById('customWrap'); w.dataset.open = w.hidden ? '1' : ''; w.hidden = !w.hidden; return }
  range = { days: Number(b.dataset.days) }; document.getElementById('customWrap').dataset.open = ''; save(); load()
})
document.getElementById('apply').addEventListener('click', () => {
  const from = document.getElementById('from').value, to = document.getElementById('to').value
  if (!from || !to || from > to) { document.getElementById('stamp').textContent = 'Pick a start date on or before the end date'; return }
  range = { from, to }; save(); load()
})
document.getElementById('refresh').addEventListener('click', () => load(true))
load()
