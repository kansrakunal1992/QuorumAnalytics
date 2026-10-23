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
const STAGES = [
  ['st1', 'Left during the chat', 12], ['st2', 'Tapped lean and priority, did not confirm', 22],
  ['st3', 'Confirmed the decision, left before the prediction', 34], ['st4', 'Saw the prediction, left before convening', 46],
  ['st5', 'Passed the quick check, never saw the synthesis', 58], ['st6', 'Chose “I’m done” (skipped the Council)', null],
  ['st7', 'Saw the synthesis, did not lock', 78], ['st8', 'Locked a decision', 100],
]
const stageColor = pctv => (pctv == null ? 'color-mix(in srgb, var(--amber) 60%, var(--surface))'
  : `color-mix(in srgb, var(--accent) ${pctv}%, var(--surface))`)
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const shortDate = (iso, opts = { day: 'numeric', month: 'short' }) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' })
const shortStamp = iso => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '–')

// ── trend chart (SVG; colours come from CSS variables so dark mode just works) ─
function trendChart(rows, lines, valueLabel = '') {
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

function journey(D) {
  const j = val(D.sections.journey)
  if (!j) return section('Where decisions stop', 'How far each chat gets.', null, errBox('Journey', D.sections.journey))
  const started = j.started
  const legend = STAGES.map(([k, label, tone]) => h('div', { class: 'jrow' },
    h('i', { style: { background: stageColor(tone) } }), h('span', null, label), h('b', null, fmt(j[k])), h('span', { class: 'muted' }, pct(j[k], started))))
  return section('Where decisions stop',
    'Every chat started in this window, grouped by the furthest point it reached.',
    'Counts chat intakes created in the window and assigns each to exactly one stage, the furthest it reached. Chats that never became a session stop at the first two stages. The “I’m done” path is a branch, not a step before the synthesis.',
    h('div', { class: 'journey' },
      h('div', { class: 'stats' }, h('div', null, h('b', null, fmt(started)), h('span', null, 'chats started')),
        h('div', null, h('b', null, j.avg_exchanges ?? '–'), h('span', null, 'average exchanges per chat'))),
      started ? h('div', { class: 'jbar', role: 'img', 'aria-label': 'Journey stages' },
        STAGES.map(([k, label, tone]) => j[k] ? h('div', { title: `${label}: ${fmt(j[k])}`, style: { flex: `${j[k]} 0 0`, background: stageColor(tone) } }) : null))
        : empty('No chats started in this window.'),
      h('div', { class: 'jlegend' }, legend),
      h('div', { class: 'miles' },
        [['Confirmed', j.confirmed], ['Saw the prediction', j.predicted], ['Reached the synthesis', j.synthesis], ['Locked', j.locked]].map(([l, v]) =>
          h('div', null, h('b', null, pct(v, started)), h('span', { class: 'muted small' }, `${l} (${fmt(v)})`))))))
}

function growth(D, days) {
  const S = D.sections, daily = rowsOf(S.daily), ev = rowsOf(S.events_daily), su = val(S.signups)
  const merged = daily.map((r, i) => ({ ...r, landing: ev[i]?.landing }))
  const lines = [{ key: 'sessions', label: 'Decisions', color: 'var(--accent)' }, { key: 'people', label: 'People deciding', color: 'var(--ink)', dash: '5 4' },
    { key: 'signups', label: 'New accounts', color: 'var(--pos)' }]
  const utm = rowsOf(S.acq_utm), inv = val(S.acq_invites), ref = val(S.acq_referrals), vc = val(S.visitor_counter)
  return section('Growth', `Day by day for ${PL}.`,
    `Days follow the ${D.params.tz} timezone. A “person” is a signed-in user, or a browser (device id) if they never signed in; if someone decided anonymously and later signed in on the same browser they count once. Decisions made without a device id or account (cookie consent declined) are counted as decisions but not as people.`,
    block('Decisions, people and accounts', null, S.daily?.ok ? trendChart(merged, lines) : errBox('Daily series', S.daily)),
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
    h('div', { class: 'blk' },
      h('div', { class: 'rowhead' }, h('p', { class: 'sub' }, `${rows.length} days. Zeros show as a dot.`), h('button', { class: 'btn', type: 'button', onclick: () => downloadCsv(D, rows) }, 'Download CSV')),
      rows.length ? h('div', { class: 'daily' }, h('div', { class: 'scrollbox' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Day'), DAILY_COLS.map(c => h('th', { class: 'num' }, c.label)))),
        h('tbody', null,
          h('tr', { class: 'tot' }, h('td', null, 'Total'), DAILY_COLS.map(c => h('td', { class: 'num' }, !S_OK(D, c.src) ? '–' : c.noTotal ? '' : c.money ? inr(tot(c.key)) : fmt(tot(c.key))))),
          newest.map(r => h('tr', { class: r.day === D.params.today ? 'today' : null },
            h('td', null, shortDate(r.day, { weekday: 'short', day: 'numeric', month: 'short' }), r.day === D.params.today ? h('span', { class: 'muted' }, ' (so far)') : null),
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
    bd.length ? block('New paid conversions', `From events in ${PL}.`, barRows(bd.map(r => ({ label: cap(r.k), value: r.n })))) : null)
}

function lifecycle(D, days) {
  const S = D.sections, sent = rowsOf(S.notif_sent), bd = rowsOf(S.events_breakdown), emails = rowsOf(S.email_sent), pf = val(S.prefs), cad = rowsOf(S.cadence)
  const fromEv = ev => Object.fromEntries(bd.filter(r => r.event === ev).map(r => [r.k, r.n]))
  const opened = fromEv('notification_opened'), toDec = fromEv('notification_to_decision'), sentBy = Object.fromEntries(sent.map(r => [r.source, r.sent]))
  const sources = [...new Set([...Object.keys(sentBy), ...Object.keys(opened), ...Object.keys(toDec)])].filter(k => k !== '(none)')
  return section('Nudges and email', `Messages sent and what they led to, for ${PL}.`,
    'Sent comes from the notification log; opened and decided come from events when a visit arrives from a tagged link, so some sources (for example review-date emails) show opens without a sent count, and untagged links show sent only.',
    block('From message to decision', null,
      S.notif_sent?.ok ? (sources.length ? table(['Source', 'Sent', 'Opened', 'Then decided', 'Opened of sent', 'Decided of opened'],
        sources.map(k => [k.replaceAll('_', ' '), fmt(sentBy[k]), fmt(opened[k]), fmt(toDec[k]), sentBy[k] && opened[k] ? pct(opened[k], sentBy[k], 1) : '–', opened[k] && toDec[k] ? pct(toDec[k], opened[k]) : '–']), [1, 2, 3, 4, 5]) : empty('Nothing sent in this window.')) : errBox('Notifications', S.notif_sent)),
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
  app.replaceChildren(pulse(D, days), journey(D), growth(D, days), daily(D), frontDoor(D, days), retention(D), inside(D, days), features(D, days), revenue(D, days), lifecycle(D, days), platform(D, days))
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
