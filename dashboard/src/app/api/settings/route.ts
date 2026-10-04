import { NextResponse } from 'next/server'
import { getAllSettings, updateSettings } from '@/lib/queries'
import { validateSettingsUpdates } from './validateSettingsUpdates'

export async function GET() {
  const settings = await getAllSettings()
  return NextResponse.json({ settings })
}

export async function PATCH(request: Request) {
  const body = await request.json()
  const result = validateSettingsUpdates((body as { updates?: unknown }).updates)
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  await updateSettings(result.updates)
  return NextResponse.json({ ok: true })
}
