import type { GridListing } from './extract/grid'
import type { PageCursor } from './paginate'

export interface PageDriver {
  gotoSearch(query: string): Promise<void>
  getGridHtml(): Promise<string>
  openListing(listing: GridListing): Promise<void>
  getDetailHtml(): Promise<string>
  refresh(): Promise<void>
  waitRandom(minMs: number, maxMs: number): Promise<void>
  fetchNextPage(cursor: PageCursor, lsd: string, query: string): Promise<string>
}
