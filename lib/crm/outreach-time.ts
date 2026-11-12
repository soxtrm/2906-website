const maltaOutreachDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Malta',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

export function formatOutreachTimestamp(iso: string): string {
  return maltaOutreachDateTime.format(new Date(iso))
}
