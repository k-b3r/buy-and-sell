import type { QueryClient } from '../../../platform/storage'
import { assembleProductDetail } from '../domain/product-detail'
import { getProductDetailRows } from '../store/product-detail'
import type { ProductDetail } from '../types'

export async function getProductDetail(db: QueryClient, productId: number): Promise<ProductDetail | null> {
  const rows = await getProductDetailRows(db, productId)
  return rows ? assembleProductDetail(rows) : null
}
