import { createInterface } from 'node:readline'

export type ReviewDecision = 'approve' | 'reject' | 'stop'

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
