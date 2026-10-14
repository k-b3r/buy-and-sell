'use server'

import { revalidateTag } from 'next/cache'

// Drops the dashboard's cached product detail (getProductDetailCached, tag
// product:ID) and product list (tag products-list) after a save toggle or a
// refresh changed what they embed. The server's routes only invalidate the
// server cache; these Next caches live here until the catalog reads move
// behind the server's cache too, then this action goes away.
export async function revalidateProduct(productId: number): Promise<void> {
  if (!Number.isInteger(productId) || productId <= 0) return
  revalidateTag(`product:${productId}`, { expire: 0 })
  revalidateTag('products-list', { expire: 0 })
}
