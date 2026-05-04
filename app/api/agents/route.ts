import { NextResponse } from 'next/server'

const BACKEND = 'http://178.104.162.193:3001'

export async function GET() {
  try {
    const res = await fetch(`${BACKEND}/api/agents`, { cache: 'no-store' })
    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ agents: [] })
  }
}
