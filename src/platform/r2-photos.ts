import {
  createR2ImageStore,
  defaultCompressImage,
  defaultFetchBytes,
  type CompressImage,
  type FetchBytes,
  type ImageStore,
  type R2Config,
} from './images'

export interface R2PhotoIo {
  store: ImageStore
  fetchBytes: FetchBytes
  compress: CompressImage
}

// Shared wiring for every entry point that re-hosts or deletes listing photos
// (spread into createListingPhotos with the caller's logger). Null when any
// R2 var is unset: each caller decides whether that is fatal or a degraded run.
export function r2PhotoIoFromEnv(
  env: Record<string, string | undefined>,
  createStore: (config: R2Config) => ImageStore = createR2ImageStore,
): R2PhotoIo | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_KEY, R2_BUCKET_NAME, R2_PUBLIC_BASE_URL } = env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_BASE_URL) return null
  return {
    store: createStore({
      accountId: R2_ACCOUNT_ID,
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_KEY,
      bucket: R2_BUCKET_NAME,
      publicBaseUrl: R2_PUBLIC_BASE_URL,
    }),
    fetchBytes: defaultFetchBytes,
    compress: defaultCompressImage,
  }
}
