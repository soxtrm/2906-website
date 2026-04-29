import { NextRequest, NextResponse } from 'next/server'

const BACKEND = 'http://178.104.162.193:3001'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const backendForm = new FormData()
    for (const [key, value] of formData.entries()) {
      backendForm.append(key, value)
    }
    const res = await fetch(`${BACKEND}/api/property-submit/photos`, {
      method: 'POST',
      body: backendForm,
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 })
  }
}
