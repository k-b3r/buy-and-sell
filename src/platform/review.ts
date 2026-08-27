import { createInterface } from 'node:readline'

export type ReviewDecision = 'approve' | 'reject' | 'stop'

export async function autoApprove(
  listing: Record<string, unknown>,
  _input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<ReviewDecision> {
  output.write(`auto-approved: ${listing.marketplace_listing_title ?? listing.id}\n`)
  return 'approve'
}

export function promptReview(
  listing: Record<string, unknown>,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<ReviewDecision> {
  output.write(JSON.stringify(listing, null, 2) + '\n')

  const rl = createInterface({ input, output, terminal: false })

  return new Promise((resolve) => {
    rl.setPrompt('[y]es / [n]o / [s]top > ')
    rl.prompt()
    rl.on('line', (line) => {
      const answer = line.trim().toLowerCase()
      if (answer === 'y' || answer === 'yes') {
        rl.close()
        resolve('approve')
      } else if (answer === 'n' || answer === 'no') {
        rl.close()
        resolve('reject')
      } else if (answer === 's' || answer === 'stop') {
        rl.close()
        resolve('stop')
      } else {
        rl.prompt()
      }
    })
  })
}
