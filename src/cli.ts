import { launchHeadedBrowser, createBrowserDriver } from './browser'
import { runCollection } from './run'
import { createLogger } from './logger'
import { promptReview } from './review'

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const query = args[0] ?? 'headphones'
  const location = args[1] ?? 'Dasmarinas, Cavite'
  const maxItemsArg = args[2]
  let maxItems: number | undefined
  if (maxItemsArg !== undefined) {
    const parsed = Number(maxItemsArg)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`invalid maxItems argument: "${maxItemsArg}"`)
    }
    maxItems = parsed
  }

  const logger = createLogger('data/collector.log')
  const { page, close } = await launchHeadedBrowser()
  const driver = createBrowserDriver(page)

  try {
    await runCollection(driver, logger, promptReview, process.stdin, process.stdout, {
      query,
      location,
      outputPath: 'data/listings.jsonl',
      softWallTimeoutMs: 5000,
      maxItems,
    })
  } finally {
    await close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
