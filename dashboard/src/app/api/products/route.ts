import { NextResponse } from 'next/server'
import { getPool } from '@/lib/db'
import { getProductSummaries } from '@/lib/queries'

const PAGE_SIZE = 30

export async function GET(request: Request) {
  const url = new URL(request.url)
  const search = url.searchParams.get('q') ?? undefined
  const category = url.searchParams.get('category') ?? undefined
  const offset = Number(url.searchParams.get('offset') ?? '0')

  const products = await getProductSummaries(getPool(), { search, category, offset, limit: PAGE_SIZE })
  const nextOffset = products.length === PAGE_SIZE ? offset + PAGE_SIZE : null

  return NextResponse.json({ products, nextOffset })
}
