import { appendFileSync } from 'node:fs'

export function appendApprovedListing(outputFilePath: string, listing: Record<string, unknown>): void {
  appendFileSync(outputFilePath, JSON.stringify(listing) + '\n')
}
