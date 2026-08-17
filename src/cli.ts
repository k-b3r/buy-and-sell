import { launchHeadedBrowser, createBrowserDriver } from './browser'
import { runCollection } from './run'
import { createLogger } from './logger'
import { promptReview } from './review'

async function main() {
  const query = process.argv[2] ?? 'headphones'
  const location = process.argv[3] ?? 'Dasmarinas, Cavite'

  const logger = createLogger('data/collector.log')
  const { page, close } = await launchHeadedBrowser()
  const driver = createBrowserDriver(page)

  try {
    await runCollection(driver, logger, promptReview, process.stdin, process.stdout, {
      query,
      location,
      outputPath: 'data/listings.jsonl',
      softWallTimeoutMs: 5000,
    })
  } finally {
    await close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
