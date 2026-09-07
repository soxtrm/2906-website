'use client'
// ============================================================================
// /owner-upload/[token] — OGX-3 owner self-upload. No CRM login: the token
// (minted from the Owner Credentials tab, /api/crm/ownergroups/:id/upload-link)
// is the only auth. Talks directly to the backend's public
// routes/ownerUpload.js, not the CRM proxy (that proxy requires the CRM
// session cookie, which an owner never has).
// ============================================================================
import { useEffect, useState, useRef } from 'react'
import { useParams } from 'next/navigation'

const BACKEND = 'http://178.104.162.193:3001/api/owner-upload'

export default function OwnerUploadPage() {
  const params = useParams()
  const token = String(params?.token || '')
  const [ownerName, setOwnerName] = useState<string | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'invalid'>('loading')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!token) return
    fetch(`${BACKEND}/${token}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => { setOwnerName(d.ownerName); setStatus('ready') })
      .catch(() => setStatus('invalid'))
  }, [token])

  async function upload(files: FileList | null) {
    if (!files || !files.length) return
    const form = new FormData()
    for (const f of Array.from(files)) form.append('files', f)
    setBusy(true); setErr(null); setDone(null)
    try {
      const res = await fetch(`${BACKEND}/${token}`, { method: 'POST', body: form })
      const d = await res.json()
      if (!res.ok) throw new Error(d?.error || 'Upload failed')
      setDone(d.uploaded)
    } catch (e: any) {
      setErr(e?.message || 'Upload failed')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div style={{ maxWidth: 480, margin: '80px auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>2906 Estate — Document upload</h1>
      {status === 'loading' && <p>Loading…</p>}
      {status === 'invalid' && <p style={{ color: '#c0392b' }}>This link is invalid or has expired. Please ask your agent for a new one.</p>}
      {status === 'ready' && (
        <>
          <p style={{ color: '#666', marginBottom: 16 }}>
            {ownerName ? `Hi ${ownerName}, ` : ''}please upload any documents your agent has requested (contracts, ID, etc.).
          </p>
          <input ref={fileRef} type="file" multiple disabled={busy} onChange={e => upload(e.target.files)} />
          {busy && <p style={{ marginTop: 12 }}>Uploading…</p>}
          {done != null && <p style={{ marginTop: 12, color: '#2e7d32' }}>{done} file{done === 1 ? '' : 's'} uploaded, thank you.</p>}
          {err && <p style={{ marginTop: 12, color: '#c0392b' }}>{err}</p>}
        </>
      )}
    </div>
  )
}
