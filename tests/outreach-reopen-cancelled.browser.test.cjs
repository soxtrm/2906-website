'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const puppeteer = require('puppeteer')

const BASE = process.env.CRM_BASE || 'http://localhost:3000'

test('cancelled TOMORROW can be reopened and becomes editable without arming', async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
  const calls = []
  const cancelled = {
    id: 102, account_id: 1, session_name: 'default', scheduled_date: '2026-11-14', scheduled_at: null,
    status: 'cancelled', armed: false, message_template: 'Quick availability check.', label: 'TOMORROW',
    stats: { total: 7, eligible: 7, hot: 0, cold: 7, skip: 0, sent: 0 },
    display: { state: 'cancelled', label: 'Cancelled' },
  }
  const today = {
    ...cancelled, id: 101, scheduled_date: '2026-11-13', status: 'draft', label: 'TODAY',
    message_template: null, stats: { total: 0, eligible: 0, hot: 0, cold: 0, skip: 0, sent: 0 },
    display: { state: 'empty', label: 'Empty' },
  }
  const later = ['IN_2_DAYS', 'IN_3_DAYS', 'IN_4_DAYS'].map((label, index) => ({
    ...today, id: 103 + index, scheduled_date: `2026-11-${15 + index}`, label,
  }))
  const plans = [today, cancelled, ...later]
  const account = {
    id: 1, sessionName: 'default', phone: '35679000001', label: 'Kev primary', connected: true,
    lastOutreachAt: null, pool: 'top', outreachVolumePercent: 30, outreachVolumeUntil: null,
    active: true, outreachEnabled: true, outreachEligible: true, sessionStatus: 'WORKING',
    operationalStatus: 'ready', restrictionsThisWeek: 0, outreachAutoEnabled: false,
    outreachAutoRolling: false, dailyTargetMin: 7, dailyTargetMax: 7, recentRuns: [],
    outreachPaceMin: 30, outreachPaceMax: 30, persona: 'kev', planningDays: [],
    quotaToday: { day: '2026-11-13', target: 7, cap: 40, used: 0, sent: 0, remaining: 40, remainingToTarget: 7 },
  }
  const overviewAccount = {
    id: 1, label: 'Kev primary', sessionName: 'default', persona: 'kev', sessionStatus: 'WORKING',
    connected: true, restricted: false, restrictionUntil: null, restrictionReason: null,
    sentToday: 0, targetToday: 7, lastAcceptedAt: null, nextRun: null,
    automation: { enabled: false, suspendedReason: null, suspendedRecoverable: null }, legacyAuto: false,
    days: [], attention: [], health: { color: 'green', code: 'ready', label: 'Ready', reason: 'Connected', action: null, telemetryAt: new Date().toISOString(), nextAt: null },
    pace: { accountId: 1, target: 7, variation: 0, min: 7, max: 7, cap: 40, version: 1, savedAt: new Date().toISOString(), savedBy: 'kevin', worker: { min: 7, max: 7, source: 'whatsapp_accounts' } },
    manualPaused: null,
  }

  try {
    const page = await browser.newPage()
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.stack || error.message))
    await page.setViewport({ width: 390, height: 844, isMobile: true })
    await page.evaluateOnNewDocument(() => { sessionStorage.setItem('argus_intro_seen', '1') })
    await page.setRequestInterception(true)
    page.on('request', request => {
      const url = new URL(request.url())
      if (!url.pathname.startsWith('/api/crm/')) return request.continue()
      const api = url.pathname.replace('/api/crm/', '')
      const json = (body, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(body) })
      if (api === 'me') return json({ agent: { id: 1, username: 'kevin', name: 'Kevin', role: 'admin' }, reveals: { used: 0, limit: 50 } })
      if (api === 'outreach/accounts') return json({ accounts: [account] })
      if (api === 'outreach/today-summary') return json({ perAccount: [], unique_owners: 0, total_sends: 0 })
      if (api === 'outreach/due-reminders') return json({ rows: [], perAccount: [] })
      if (api === 'outreach/owner-recheck') return json({ mode: 'REVIEW_ONLY', tasks: [] })
      if (api === 'outreach/templates') return json({ templates: [] })
      if (api === 'outreach/control/overview') return json({
        generatedAt: new Date().toISOString(), today: '2026-11-13', timezone: 'Europe/Malta',
        kpi: { sentToday: 0, scheduled: 0, remaining: 7, nextRun: null, activeAccounts: 1, accounts: 1, attention: [], health: { green: 1, yellow: 0, red: 0, gray: 0, unknown: 0 } },
        accounts: [overviewAccount],
      })
      if (api === 'outreach/pace/1') return json(overviewAccount.pace)
      if (api === 'outreach/plans' && url.searchParams.get('accountId') === '1') return json({ plans })
      if (api === 'outreach/plans/102' && request.method() === 'GET') {
        return json({ plan: { ...cancelled, entries: Array.from({ length: 7 }, (_, index) => ({ id: index + 1, normalized_phone: `3567999999${index}`, display_name: `Owner ${index}`, classification: 'cold', eligibility_status: 'eligible', skip_reason: null, send_status: 'pending', sent_at: null })) } })
      }
      if (api === 'outreach/plans/102/reopen' && request.method() === 'POST') {
        calls.push('reopen')
        cancelled.status = 'draft'
        cancelled.display = { state: 'auto_prepared', label: 'Draft' }
        return json({ ok: true, plan: cancelled })
      }
      return json({})
    })

    await page.goto(`${BASE}/crm/outreach`, { waitUntil: 'networkidle2', timeout: 120000 })
    try {
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent?.includes('Manual planner')), { timeout: 8000 })
    } catch (error) {
      assert.fail(`Manual planner did not render. Page errors: ${pageErrors.join(' | ')} Body: ${(await page.evaluate(() => document.body.innerText)).slice(0, 1200)}`)
    }
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Manual planner'))?.click())
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent?.includes('Reopen TOMORROW')))

    assert.match(await page.evaluate(() => document.body.innerText), /Reopen TOMORROW to edit this queue or create a new list/)
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /\bARM\b/)
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent?.includes('Reopen TOMORROW'))?.click())

    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Contact queue"]') && document.body.innerText.includes('Nothing was armed or sent'))
    assert.deepEqual(calls, ['reopen'])
    assert.match(await page.evaluate(() => document.body.innerText), /Nothing was armed or sent/)
    assert.match(await page.evaluate(() => document.body.innerText), /\bARM\b/)
  } finally {
    await browser.close()
  }
})
