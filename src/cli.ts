import { launchHeadedBrowser, createBrowserDriver } from './browser'
import { runCollection } from './run'
import { createLogger } from './logger'
import { promptReview } from './review'

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const query = args[0] ?? 'headphones'
  const location = args[1] ?? 'Dasmarinas, Cavite'
  const maxItemsArg = process.argv[4]
  const maxItems = maxItemsArg ? Number(maxItemsArg) : undefined

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
