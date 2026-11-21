// End-to-end viewing follow-up test against the staging service (tunnel to 127.0.0.1:3902).
// Signs in as the synthetic Katya through the real CRM login, books, opens owner info,
// travels to the next day, answers, reschedules and completes. Prints a step log only.
const B = process.env.STAGE || 'http://127.0.0.1:3902'
const log = []
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); log.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); if (!cond) process.exitCode = 1 }
async function call(method, path, token, body) {
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  let d = null; try { d = await r.json() } catch {}
  return { status: r.status, body: d }
}
const maltaAt = (daysAhead, h, mi = 0) => {
  const d = new Date(Date.now() + daysAhead * 86400e3)
  const [y, m, dd] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Malta' }).format(d).split('-').map(Number)
  const guess = new Date(Date.UTC(y, m - 1, dd, h, mi))
  const off = (new Date(guess.toLocaleString('en-US', { timeZone: 'Europe/Malta' })) - new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }))) / 60e3
  return new Date(guess.getTime() - off * 60e3)
}

const login = async (who) => (await call('POST', '/api/crm/login', null, { emailOrUsername: `${who}.stage@example.test`, password: 'stage-pass-2026' })).body
const katya = await login('katya'); const nico = await login('nico')
ok('Katya signs in through /api/crm/login (board account)', !!katya?.token, katya?.agent?.role)
ok('Nico signs in (agent without owner access)', !!nico?.token)
const K = katya.token, N = nico.token

const slot = maltaAt(1, 16, 0)
for (const [d, h1, h2] of [[1, 15, 18], [4, 10, 13]]) {
  const w = await call('POST', '/api/crm/schedule-board/listings/9901/viewing-window', K, { start: maltaAt(d, h1).toISOString(), end: maltaAt(d, h2).toISOString() })
  ok(`Katya records the owner's viewing hours (day +${d})`, w.status === 200, w.status === 200 ? '' : JSON.stringify(w.body).slice(0, 140))
}
const view = await call('GET', '/api/crm/schedule-board/listings/9901/booking', K)
ok('booking view of #9901 loads', view.status === 200, `status ${view.status}`)
const book = await call('POST', '/api/crm/schedule-board/listings/9901/booking', K, { startsAt: slot.toISOString(), durationMin: 20, appointmentType: 'first_view', clientName: 'Synthetic Client', groupSize: 2 })
ok('Katya creates a booking request for tomorrow 16:00', book.status === 200, book.body?.message || JSON.stringify(book.body).slice(0, 160))
const viewingId = book.body?.booking?.id
await call('POST', '/stage/tick', null, { at: new Date().toISOString() })
let list = await call('GET', '/api/crm/viewing-followups', K)
let f = list.body?.followups?.find(x => x.viewingId === viewingId)
ok('the request is tracked at once (owner window: ' + (book.body?.confirmed ? 'auto-confirmed' : 'requested') + '), feedback upcoming', !!f && f.state === (book.body?.confirmed ? 'confirmed' : 'requested') && f.feedback === 'scheduled', f && `${f.state}/${f.feedback}, due ${f.dueDate}`)

const info = await call('GET', `/api/crm/viewing-followups/by-viewing/${viewingId}/owner-info`, K)
ok('Get Owner Info works for Katya on the booking request', info.status === 200 && !!info.body?.owner?.phone, `${info.body?.owner?.name} · booking ${info.body?.bookingState}`)
const denied = await call('GET', `/api/crm/viewing-followups/by-viewing/${viewingId}/owner-info`, N)
ok('Nico gets no owner contact (direct API call)', denied.status === 403, `status ${denied.status}`)
ok('no phone number in the follow-up list', !JSON.stringify(list.body).includes('35699100777'))

// next day, 10:00 Malta: the question goes to Katya's workspace group
const box0 = (await call('GET', '/stage/outbox')).body.length
await call('POST', '/stage/tick', null, { at: maltaAt(2, 10, 0).toISOString() })
let box = (await call('GET', '/stage/outbox')).body
const q1 = box.slice(box0).find(m => m.via === 'followup')
ok('next day 10:00: one question to Katya’s workspace group', !!q1 && q1.chat === '120363000000000013@g.us', q1?.text?.split('\n')[0])
ok('wording matches the booking state and asks, never assumes', !!q1 && (book.body?.confirmed ? /you had a viewing planned for #9901 Sliema yesterday at 16:00\. Did it take place\?/ : /had not confirmed it\. Did it take place\?/).test(q1.text) && !/How was the viewing/.test(q1.text))
await call('POST', '/stage/tick', null, { at: maltaAt(2, 10, 30).toISOString() })
box = (await call('GET', '/stage/outbox')).body
ok('asked once, not again on the next pass', box.filter(m => m.via === 'followup').length === 1)
await call('POST', '/stage/tick', null, { at: maltaAt(2, 22, 0).toISOString() })

list = await call('GET', '/api/crm/viewing-followups', K); f = list.body.followups.find(x => x.viewingId === viewingId)
ok('dashboard shows Feedback due', f.feedback === 'asked')
let a = await call('POST', `/api/crm/viewing-followups/${f.id}/answer`, K, { outcome: 'awaiting', note: 'Client did not confirm yet' })
ok('Katya answers Awaiting confirmation', a.status === 200 && a.body.followup.feedback === 'due', a.body?.followup?.feedback)
await call('POST', '/stage/tick', null, { at: maltaAt(3, 10, 0).toISOString() })
box = (await call('GET', '/stage/outbox')).body
ok('asked again the following day', box.filter(m => m.via === 'followup').length === 2)

// the booking itself moves three days later: the follow-up follows it
const moved = maltaAt(4, 11, 0)
const pat = await call('PATCH', `/api/crm/schedule-board/bookings/${viewingId}`, K, { startsAt: moved.toISOString(), durationMin: 20 })
ok('Katya reschedules the booking in the board', pat.status === 200, JSON.stringify(pat.body).slice(0, 140))
await call('POST', '/stage/tick', null, { at: maltaAt(3, 12, 0).toISOString() })
list = await call('GET', '/api/crm/viewing-followups', K); f = list.body.followups.find(x => x.viewingId === viewingId)
ok('follow-up moved with it: Rescheduled, upcoming again', f.state === 'rescheduled' && f.feedback === 'scheduled' && new Date(f.slotAt).getTime() === moved.getTime(), `${f.state}/${f.feedback} ${f.slotAt}`)

// the agent reports another new time directly in the follow-up
const later = maltaAt(5, 17, 30)
a = await call('POST', `/api/crm/viewing-followups/${f.id}/answer`, K, { outcome: 'rescheduled', newStartsAt: later.toISOString(), note: 'Client asked for Friday evening' })
ok('Katya answers Rescheduled with a new time', a.status === 200 && new Date(a.body.followup.slotAt).getTime() === later.getTime())
await call('POST', '/stage/tick', null, { at: maltaAt(5, 12, 0).toISOString() })
box = (await call('GET', '/stage/outbox')).body
ok('no question before the new slot', box.filter(m => m.via === 'followup').length === 2)
await call('POST', '/stage/tick', null, { at: maltaAt(6, 10, 0).toISOString() })
box = (await call('GET', '/stage/outbox')).body
ok('asked the day after the new time', box.filter(m => m.via === 'followup').length === 3)
a = await call('POST', `/api/crm/viewing-followups/${f.id}/answer`, K, { outcome: 'completed', nextStep: 'offer', note: 'Client wants to make an offer' })
ok('Katya answers Completed, next step Offer', a.status === 200 && a.body.followup.state === 'completed' && a.body.followup.nextStep === 'offer')
const kinds = a.body.timeline.map(e => e.kind)
ok('timeline holds the whole story', ['created', 'owner_info_viewed', 'due', 'asked', 'answered', 'rescheduled'].every(k => kinds.includes(k)), kinds.join(' → '))

// old and far appointments
list = await call('GET', '/api/crm/viewing-followups', K)
const far = list.body.followups.filter(x => new Date(x.slotAt) > new Date(Date.now() + 30 * 86400e3))
const legacy = list.body.followups.filter(x => x.channel === 'agent_book')
ok('a 40-days-ahead request created 90 days ago is visible', far.length >= 1)
ok('an old /book request (date + time only) is visible with its time', legacy.length === 1 && new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Malta', hour: '2-digit', minute: '2-digit' }).format(new Date(legacy[0].slotAt)) === '16:30')
const nicoList = await call('GET', '/api/crm/viewing-followups', N)
ok('Nico sees only his own requests (none)', nicoList.body.scope === 'mine' && nicoList.body.followups.length === 0)
const ownerMsgs = box.filter(m => m.via === 'waha')
ok('no message was sent to an owner or client by the follow-up', box.filter(m => m.via === 'followup').every(m => m.chat === '120363000000000013@g.us'), `${ownerMsgs.length} owner-ask message(s) from the existing booking flow captured, not sent`)
console.log(log.join('\n'))
