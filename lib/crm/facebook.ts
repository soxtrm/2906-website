// ARGUS × Facebook Business Pages — client for /api/crm/facebook-pages/*.
// The backend owns every token; the browser only ever sees our own ids,
// Page names and Meta's public post links.
import { crmFetch, crmJson } from './api'

export type FbPage = {
  id: number; pageId: string; name: string; pictureUrl: string | null; category: string | null
  canPublish: boolean; status: 'active' | 'missing_permission' | 'removed' | 'disconnected'; statusReason: string | null
  enabled: boolean; isDefault: boolean; autoPublish: boolean; lastSyncedAt: string
}
export type FbTemplate = { id: string; name: string; description?: string; language?: string; body?: string; builtIn: boolean }
export type FbPreferences = {
  language: 'en' | 'mt' | 'de'; defaultTemplateId: string; useEmojis: boolean; includeContact: boolean; includeLink: boolean
  callToAction: string; autoPublishEnabled: boolean; autoDailyLimit: number
}
export type FbStatus = {
  configured: boolean; setupMissing: string[]; appId: string | null; graphVersion: string; autoPublishAvailable: boolean
  connection: { state: 'not_connected' | 'active' | 'reconnect_required'; reason?: string | null; facebookName?: string | null; connectedAt?: string; lastCheckedAt?: string | null; tokenExpiresAt?: string | null; missingPermissions?: string[] }
  pages: FbPage[]; preferences: FbPreferences; templates: FbTemplate[]
  agent: { displayName: string; publicPhone: string | null; colorHex: string | null }
}
export type FbPublication = {
  id: number; propertyId: number; propertyRef: string | null; pageRowId: number | null; pageName: string | null
  publicationType: 'text' | 'link' | 'photo' | 'multi_photo'; state: string; stateLabel: string; trigger: 'manual' | 'auto_verified' | 'replacement'
  message: string; images: string[]; link: string | null; language: string; template: string | null
  postId: string | null; permalinkUrl: string | null; publishedAt: string | null; lastCheckedAt: string | null
  error: { kind: string; message: string } | null; nextAttemptAt: string | null; attemptCount: number; replacesId: number | null
  editedAt: string | null; createdAt: string; updatedAt: string; canEdit: boolean; canDelete: boolean; canRetry: boolean
}
export type FbBlocker = { code: string; message: string }
export type FbDraft = {
  property: { id: number; ref: string | null; type: string | null; town: string | null; bedrooms: number | null; bathrooms: number | null; rent: number | null; sale: number | null; availableStatus: string; availableDate: string | null }
  images: { url: string; thumbnail: string | null }[]; imagesAllowed: boolean; imagesReason: string | null; maxImages: number
  link: string | null; linkKind: 'website' | 'share' | null; message: string; language: 'en' | 'mt' | 'de'; templateId: string
  emojis: boolean; includeContact: boolean; includeLink: boolean; blockers: FbBlocker[]; publications: FbPublication[]
}
export type FbError = Error & { status?: number; data?: { error?: string; kind?: string; blockers?: FbBlocker[]; existing?: FbPublication[]; canReplace?: boolean } }

const P = 'facebook-pages'
export const fb = {
  status: (): Promise<FbStatus> => crmFetch(`${P}/status`),
  connect: (): Promise<{ url: string }> => crmJson(`${P}/connect`, 'POST', {}),
  complete: (body: { code?: string | null; state?: string | null; error?: string | null }): Promise<FbStatus> => crmJson(`${P}/connect/complete`, 'POST', body),
  refresh: (): Promise<FbStatus> => crmJson(`${P}/refresh`, 'POST', {}),
  check: (): Promise<FbStatus> => crmJson(`${P}/check`, 'POST', {}),
  disconnect: (): Promise<{ disconnected: boolean; revokedAtMeta: boolean; status: FbStatus }> => crmJson(`${P}/disconnect`, 'POST', {}),
  updatePage: (id: number, body: Partial<{ enabled: boolean; isDefault: boolean; autoPublish: boolean }>): Promise<FbStatus> => crmJson(`${P}/pages/${id}`, 'PATCH', body),
  updatePreferences: (body: Partial<FbPreferences>): Promise<FbStatus> => crmJson(`${P}/preferences`, 'PATCH', body),
  addTemplate: (body: { name: string; body: string; language: string }): Promise<FbStatus> => crmJson(`${P}/templates`, 'POST', body),
  deleteTemplate: (id: string): Promise<FbStatus> => crmJson(`${P}/templates/${id}`, 'DELETE'),
  draft: (propertyId: number, o: { language?: string; templateId?: string; emojis?: boolean; contact?: boolean; link?: boolean; cta?: string } = {}): Promise<FbDraft> => {
    const q = new URLSearchParams()
    if (o.language) q.set('language', o.language)
    if (o.templateId) q.set('templateId', o.templateId)
    if (o.emojis !== undefined) q.set('emojis', o.emojis ? '1' : '0')
    if (o.contact !== undefined) q.set('contact', o.contact ? '1' : '0')
    if (o.link !== undefined) q.set('link', o.link ? '1' : '0')
    if (o.cta) q.set('cta', o.cta)
    return crmFetch(`${P}/properties/${propertyId}/draft?${q}`)
  },
  publish: (body: { propertyId: number; pageRowId: number; message: string; images: string[]; includeLink: boolean; idempotencyKey: string; confirmDuplicate?: boolean; language?: string; templateId?: string; replacesId?: number }): Promise<{ publication: FbPublication; replayed: boolean }> =>
    crmJson(`${P}/publications`, 'POST', body),
  publications: (o: { propertyId?: number; limit?: number } = {}): Promise<{ publications: FbPublication[] }> =>
    crmFetch(`${P}/publications?${new URLSearchParams(Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))}`),
  publication: (id: number): Promise<{ publication: FbPublication }> => crmFetch(`${P}/publications/${id}`),
  checkPublication: (id: number): Promise<{ publication: FbPublication }> => crmJson(`${P}/publications/${id}/check`, 'POST', {}),
  retry: (id: number, confirm = false): Promise<{ publication: FbPublication }> => crmJson(`${P}/publications/${id}/retry`, 'POST', { confirm }),
  edit: (id: number, message: string): Promise<{ publication: FbPublication }> => crmJson(`${P}/publications/${id}`, 'PATCH', { message }),
  remove: (id: number): Promise<{ publication: FbPublication }> => crmJson(`${P}/publications/${id}`, 'DELETE', { confirm: true }),
}

export function newRequestId() {
  const a = new Uint8Array(16)
  crypto.getRandomValues(a)
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('')
}

// The official, user-mediated Share Dialog for an agent's personal profile.
export function personalShareUrl(appId: string | null, href: string) {
  if (!appId) return null
  const u = new URL('https://www.facebook.com/dialog/share')
  u.searchParams.set('app_id', appId)
  u.searchParams.set('display', 'page')
  u.searchParams.set('href', href)
  return u.toString()
}

export const errorMessage = (e: unknown, fallback = 'Something went wrong. Please try again.') =>
  (e as FbError)?.data?.error || (e as Error)?.message || fallback

export const PUB_TONE: Record<string, 'ok' | 'busy' | 'warn' | 'bad' | 'muted'> = {
  published: 'ok', queued: 'busy', publishing: 'busy', reconciling: 'busy', draft: 'muted',
  failed: 'bad', reconnect_required: 'warn', needs_review: 'warn', removed: 'muted', cancelled: 'muted',
}
export const TYPE_LABEL: Record<string, string> = { text: 'Text post', link: 'Link post', photo: 'Photo post', multi_photo: 'Multi-photo post' }
