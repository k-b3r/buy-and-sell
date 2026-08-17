import type { GridListing } from './extract/grid'

export interface PageDriver {
  gotoSearch(query: string, location: string): Promise<void>
  getGridHtml(): Promise<string>
  openListing(listing: GridListing): Promise<void>
  getDetailHtml(): Promise<string>
  refresh(): Promise<void>
  waitRandom(minMs: number, maxMs: number): Promise<void>
}
