'use strict'

// Read-only evidence for the "Upload once" flow. Channel failures never
// mutate the canonical CRM property; they are surfaced for an agent to fix.
function summarise(events, names, idleStatus, idleDetail) {
  const rows = events.filter(event => names.includes(event.channel))
  const posted = rows.filter(row => row.status === 'posted')
  const waiting = rows.filter(row => ['scheduled', 'pending', 'processing'].includes(row.status))
  const failed = rows.filter(row => row.status === 'failed')
  if (posted.length) return { status: 'posted', count: posted.length, detail: `${posted.length} destination${posted.length === 1 ? '' : 's'} posted` }
  if (waiting.length) return { status: 'scheduled', count: waiting.length, detail: `${waiting.length} destination${waiting.length === 1 ? '' : 's'} queued` }
  if (failed.length) return { status: 'attention', count: failed.length, detail: `${failed.length} destination${failed.length === 1 ? '' : 's'} need review` }
  return { status: idleStatus, detail: idleDetail }
}

async function loadPropertyDistribution(db, property) {
  const [publishing, website] = await Promise.all([
    db.query(
      `SELECT channel,target_ref,status,scheduled_for,posted_at,external_ref,
              attempt_count,last_error,updated_at
         FROM property_publishing_status
        WHERE property_id=$1
        ORDER BY updated_at DESC`, [property.id]),
    db.query(
      `SELECT id,slug,is_published,updated_at
         FROM website_properties
        WHERE property_reference=$1
        ORDER BY updated_at DESC LIMIT 1`, [property.ref]),
  ])
  const events = publishing.rows
  const websiteRow = website.rows[0]
  const websiteEvents = events.filter(event => event.channel === 'website')
  const websiteWaiting = websiteEvents.some(row => ['scheduled', 'pending', 'processing'].includes(row.status))
  const websiteFailed = websiteEvents.some(row => row.status === 'failed')
  const websiteState = websiteRow?.is_published
    ? { status: 'live', detail: websiteRow.slug ? `Live · /properties/${websiteRow.slug}` : 'Live on 2906' }
    : websiteWaiting
      ? { status: 'syncing', detail: 'Website publication queued' }
      : websiteFailed
        ? { status: 'attention', detail: 'Website publication needs review' }
        : property.published
          ? { status: 'syncing', detail: 'Public listing enabled · awaiting website record' }
          : { status: 'off', detail: 'Public listing disabled' }

  return {
    channels: [
      { key: 'crm', label: 'CRM', status: 'connected', detail: 'Canonical property record' },
      { key: 'agent_board', label: 'Agent Board', status: 'connected', detail: 'Visible in operational inventory' },
      { key: 'website', label: '2906 Website', ...websiteState },
      { key: 'facebook', label: 'Facebook', ...summarise(events, ['facebook', 'fb_direct_share', 'fb_group', 'fb_groups'], 'ready', 'Ready when selected') },
      { key: 'owner_groups', label: 'Owner groups', ...summarise(events, ['category_groups', 'category_groups_agent', 'viewing_group'], 'ready', 'Ready when selected') },
      { key: 'marketplaces', label: 'Marketplaces', status: 'ready', detail: 'Channel-ready export' },
      { key: 'matched_clients', label: 'Matched clients', status: 'manual', detail: 'Agent approval required' },
    ],
    events: events.slice(0, 30),
  }
}

module.exports = { loadPropertyDistribution, summarise }
