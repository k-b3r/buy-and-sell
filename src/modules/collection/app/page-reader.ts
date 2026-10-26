import type { GridListing } from '../domain/extract-grid'
import { extractGridListings, looksLikeListing } from '../domain/extract-grid'
import { extractDetailFields } from '../domain/extract-detail'
import type { PageCursor } from '../domain/paginate'
import { extractCursor, extractLsd, parsePaginationResponse } from '../domain/paginate'

// One function per kind of page the collect loop reads: the search grid, a page
// of the paginated feed, and one listing's detail page. Each returns exactly
// what the loop needs, so Facebook's embedded JSON stays this module's problem
// and the parsing helpers stay out of index.ts (they are free to change without
// moving the module's API).

// The search grid as the loop sees it: the listings it holds, plus the token
// and LSD the next-page request needs (either is null when the feed has no
// more pages, or the page did not carry it).
export interface GridPage {
  listings: GridListing[]
  cursor: PageCursor | null
  lsd: string | null
}

export function readGridPage(html: string): GridPage {
  return { listings: extractGridListings(html), cursor: extractCursor(html), lsd: extractLsd(html) }
}

// One page after the grid. `skipped` counts feed nodes that are not
// listing-shaped at all, so the loop can log how many it dropped; a null return
// means the response was not the pagination shape, which the loop treats as a
// stop (fail closed) rather than an empty page.
export interface NextPage {
  listings: GridListing[]
  skipped: number
  nextCursor: PageCursor | null
  hasNextPage: boolean
}

export function readNextPage(json: string): NextPage | null {
  const page = parsePaginationResponse(json)
  if (!page) return null
  const listings = page.nodes.filter(looksLikeListing) as unknown as GridListing[]
  return {
    listings,
    skipped: page.nodes.length - listings.length,
    nextCursor: page.nextCursor,
    hasNextPage: page.hasNextPage,
  }
}

// A listing's own detail page: the fields the loop merges over the grid
// listing before review and save (empty when the page carried no listing).
export function readDetailFields(html: string): Record<string, unknown> {
  return extractDetailFields(html)
}
