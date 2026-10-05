// Coercions for raw pg rows, shared by the server's dashboard queries and the
// modules' own query exports. pg returns NUMERIC as a string and timestamps as
// Date, while the dashboard RPC wants plain JSON numbers and ISO strings.

export function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

export function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return value instanceof Date ? value.toISOString() : (value as string)
}

// primary_photo_url is Facebook's own CDN link, which expires/requires a
// live FB session - confirmed live 2026-08-23 against real Sony WH-1000XM6
// listings (broken thumbnail on the product's listing cards, but fine on the
// single listing page) because only getListingDetail's query preferred
// stored_photo_urls (the durable R2-hosted copy); getProductDetail's listing
// query didn't select it at all. Single source of truth for both now.
export function resolvePhotoUrls(storedPhotoUrls: unknown, primaryPhotoUrl: unknown): string[] {
  const stored = storedPhotoUrls as string[] | null
  if (stored && stored.length > 0) return stored
  return primaryPhotoUrl ? [primaryPhotoUrl as string] : []
}
