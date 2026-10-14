import type { DbClient, QueryClient } from '../../../platform/storage'
import { resolvePhotoUrls, toIsoOrNull, toNullableNumber } from '../../../platform/rows'
import { medianCtes, notMagnitudeOutlierSql, peerListingSql } from './fragments'

export interface ProductCleanMedian {
  medianPrice: number
  sampleSize: number
}

export type SoldComparablePrice = ProductCleanMedian

// Which of a product's listings a clean median is taken over: sold ones
// (what it was asking when it sold) or peers (see peerListingSql).
export type ListingScope = 'sold' | 'peer'

const SCOPE_SQL: Record<ListingScope, string> = {
  sold: 'pl.sold_at IS NOT NULL',
  peer: peerListingSql('pl'),
}

// One product's clean median over its listings in scope, excluded products
// never priced - null below MIN_PEER_SAMPLE valid prices (medianCtes). Backs
// the sold-comp and peer reference prices here and discount detection's peer
// fallback.
export async function getProductCleanMedian(
  db: DbClient,
  productId: number,
  options: { scope: ListingScope },
): Promise<ProductCleanMedian | null> {
  const result = (await db.query(
    `WITH ${medianCtes({
      name: 'product',
      pool: `SELECT pl.product_id, pl.price_amount FROM listings pl
             JOIN products p ON p.id = pl.product_id
             WHERE pl.product_id = $1 AND ${SCOPE_SQL[options.scope]} AND NOT p.price_lookup_excluded`,
    })}
    SELECT sample_size, clean_median_price FROM product`,
    [productId],
  )) as { rows: Record<string, unknown>[] }
  const row = result.rows[0]
  if (!row) return null

  const sampleSize = Number(row.sample_size)
  const medianPrice = toNullableNumber(row.clean_median_price)
  if (medianPrice === null || medianPrice <= 0) return null

  return { medianPrice, sampleSize }
}

// Listings Facebook has actually marked sold (sold_at IS NOT NULL) instead
// of current asking prices - a real transacted-market signal, not just what
// someone's currently hoping to get. Facebook doesn't expose the actual
// agreed sale price logged-out, so this is "what it was asking when it
// sold," not a true transaction price - still materially better than an
// active listing's ask, which nobody has paid yet. The deals page's highest
// "sold_comps" confidence tier.
export async function getSoldComparablePrice(db: QueryClient, productId: number): Promise<SoldComparablePrice | null> {
  return getProductCleanMedian(db, productId, { scope: 'sold' })
}

export type PeerMedianPrice = ProductCleanMedian

// Deals page's second-tier reference price: median of the same product's peer
// listings (active plus recently sold or removed, see peerListingSql), used when
// getSoldComparablePrice above has too few actual sales to trust.
// Per-product so the deals page can call this once per product instead of
// once per listing.
export async function getPeerMedianPrice(db: QueryClient, productId: number): Promise<PeerMedianPrice | null> {
  return getProductCleanMedian(db, productId, { scope: 'peer' })
}

export interface ComparableListing {
  listing_id: string
  title: string
  price_amount: number
  photo_url: string | null
  date: string | null
}

const COMPARABLE_LISTINGS_DEFAULT_LIMIT = 6

// Backs the listing-detail page's "recent sales" / "similar listings"
// evidence panel - the actual rows behind getSoldComparablePrice/
// getPeerMedianPrice's clean median, not just the aggregate number. Empty
// below MIN_PEER_SAMPLE comparables (no median, nothing to show as evidence).
interface ComparableListingsQuery {
  productId: number
  excludeListingId: string
  sold: boolean
  limit?: number
}

export async function getComparableListings(
  db: QueryClient,
  { productId, excludeListingId, sold, limit = COMPARABLE_LISTINGS_DEFAULT_LIMIT }: ComparableListingsQuery,
): Promise<ComparableListing[]> {
  const scopeClause = SCOPE_SQL[sold ? 'sold' : 'peer']
  const dateColumn = sold ? 'pl.sold_at' : 'pl.listed_at'

  const result = await db.query(
    `WITH ${medianCtes({
      name: 'product',
      pool: `SELECT pl.product_id, pl.id, pl.title, pl.price_amount, pl.primary_photo_url, pl.stored_photo_urls, ${dateColumn} AS date
             FROM listings pl
             JOIN products p ON p.id = pl.product_id
             WHERE pl.product_id = $1 AND pl.id != $2 AND ${scopeClause} AND NOT p.price_lookup_excluded`,
      clean: false,
    })}
     SELECT pp.id AS listing_id, pp.title, pp.price_amount, pp.primary_photo_url, pp.stored_photo_urls, pp.date
     FROM product_prices pp
     JOIN product m ON m.product_id = pp.product_id
     WHERE m.raw_median_price IS NOT NULL AND ${notMagnitudeOutlierSql('pp.price_amount', 'm.raw_median_price')}
     ORDER BY pp.date DESC NULLS LAST
     LIMIT $3`,
    [productId, excludeListingId, limit],
  )

  return (result.rows as Record<string, unknown>[]).map((r) => ({
    listing_id: r.listing_id as string,
    title: r.title as string,
    price_amount: Number(r.price_amount),
    photo_url: resolvePhotoUrls(r.stored_photo_urls, r.primary_photo_url)[0] ?? null,
    date: toIsoOrNull(r.date),
  }))
}
