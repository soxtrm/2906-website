export function normalizeOutreachCountDraft(draft: string, previous: number, maximum: number) {
  const trimmed = draft.trim()
  if (!trimmed || !/^\d+$/.test(trimmed)) return previous

  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return previous

  return Math.max(1, Math.min(maximum, Math.trunc(parsed)))
}
