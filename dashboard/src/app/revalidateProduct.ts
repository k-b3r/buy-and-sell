'use server'

import { revalidateTag } from 'next/cache'

// Drops the dashboard's cached product detail (getProductDetailCached, tag
// product:ID) after a save toggle changes the saved flag it embeds. The
// server's save route only invalidates the server cache; this Next cache lives
// here until product detail moves behind the server's cache too, then this
// action goes away.
export async function revalidateProduct(productId: number): Promise<void> {
  if (!Number.isInteger(productId) || productId <= 0) return
  revalidateTag(`product:${productId}`, { expire: 0 })
}
