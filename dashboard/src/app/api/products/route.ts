import { NextResponse } from 'next/server'
import { getPool } from '@/lib/db'
import { getProductSummariesCached } from '@/lib/cachedQueries'

const PAGE_SIZE = 30

export async function GET(request: Request) {
  const url = new URL(request.url)
  const search = url.searchParams.get('q') ?? undefined
  const categories = url.searchParams.getAll('category')
  const subCategories = url.searchParams.getAll('subCategory')
  const offset = Number(url.searchParams.get('offset') ?? '0')

  const products = await getProductSummariesCached(getPool(), { search, categories, subCategories, offset, limit: PAGE_SIZE })
  const nextOffset = products.length === PAGE_SIZE ? offset + PAGE_SIZE : null

  return NextResponse.json({ products, nextOffset })
}
