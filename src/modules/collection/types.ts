// Types and ports shared by this module's own files. Row types stay in store/.

import type { DelayFn } from '../../platform/delay'
import type { ImageStore, CompressImage, FetchBytes } from '../../platform/images'
import type { Logger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'
import type { GridListing } from './domain/extract-grid'
import type { PageCursor } from './domain/paginate'

// The collect worker's --cycle search-query list - editable via the Settings page's
// collect tab (add/remove rows, not per-field number knobs like the rest of
// settings, hence its own table/endpoint instead of a settings row).
export interface CollectKeyword {
  keyword: string
  enabled: boolean
}

export interface LapQuery {
  query: string
  maxItems: number
}

export interface LapPlanInput {
  general: string[]
  realEstate: string[]
  lap: number
  reEnabled: number
  reEveryNLaps: number
  reMaxItems: number
  defaultMaxItems: number
}

// A raw Facebook listing object parsed down to the columns a write touches.
export interface ListingFields {
  id: string
  title: string | null
  priceAmount: number | null
  priceCurrency: string | null
  description: string | null
  condition: string | null
  categoryId: string | null
  locationLat: number | null
  locationLng: number | null
  locationCity: string | null
  primaryPhotoUrl: string | null
  storedPhotoUrls: string[] | null
  listedAt: Date | null
}

export interface PageDriver {
  gotoSearch(query: string, daysSinceListed: number): Promise<void>
  getGridHtml(): Promise<string>
  openListing(listing: GridListing): Promise<void>
  getDetailHtml(): Promise<string>
  refresh(): Promise<void>
  waitRandom(minMs: number, maxMs: number): Promise<void>
  fetchNextPage(cursor: PageCursor, lsd: string, query: string): Promise<string>
}

// What every live page flow (collection run, recheck, photo backfill) reads
// pages through; delay waits out a soft login-wall before refreshing.
export interface PageIo {
  driver: PageDriver
  logger: Logger
  delay: DelayFn
}

// PageIo plus the listing writes a recheck or photo backfill makes.
export interface ListingPageIo extends PageIo {
  db: DbClient
  photos: ListingPhotos
}

// A launched browser's driver plus the handle that tears the browser down.
export interface BrowserDriver {
  driver: PageDriver
  close: () => Promise<void>
}

export interface BrowserProxy {
  server: string
  username?: string
  password?: string
}

// launchBrowserDriver's shape (browser.ts), injected where tests swap in a fake browser.
export type DriverFactory = (proxy?: BrowserProxy) => Promise<BrowserDriver>

export type ProxyChecker = (proxyUrl: string) => Promise<boolean>

export interface ResolvedProxy {
  server: string
  username?: string
  password?: string
  source: 'webshare' | 'tunnel'
}

export interface ProxyResolution {
  ok: boolean
  error?: string
  proxy?: ResolvedProxy
}

export interface ProxyEnv {
  WEBSHARE_PROXY?: string
  SOCKS_PROXY?: string
}

// A listing's re-hosted photo carousel, stored under listings/<id>/. Built once
// per entry point from platform/images' real I/O (createR2ImageStore,
// defaultFetchBytes, defaultCompressImage) so this module, and so its index,
// never loads sharp or the S3 SDK.
export interface ListingPhotos {
  // Returns the public URLs of the photos that made it, in carousel order.
  save(listingId: string, photos: unknown): Promise<string[]>
  // save, plus pruneUnused to delete the listing's stored objects the new set
  // no longer uses (fewer photos, or a photo whose extension changed). The
  // caller runs pruneUnused only once its DB row points at the new urls, so a
  // failed write never leaves the row pointing at deleted objects. It deletes
  // nothing when the new set saved nothing; a failed delete is logged, never thrown.
  replace(listingId: string, photos: unknown): Promise<ReplacedPhotos>
  deleteAll(listingId: string): Promise<void>
}

interface ReplacedPhotos {
  urls: string[]
  pruneUnused(): Promise<void>
}

export interface ListingPhotosIo {
  store: ImageStore
  fetchBytes: FetchBytes
  compress: CompressImage
  logger: Logger
}
