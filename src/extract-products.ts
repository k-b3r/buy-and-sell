import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Logger } from './logger'
import { createLogger } from './logger'
import type { GeminiClient } from './gemini'
import { createGeminiClient } from './gemini'
import type { DbClient } from './db'
import { createDbPool, findOrCreateProduct } from './db'
import { loadListings, saveListings } from './jsonl'
import { buildExtractionPrompt, EXTRACTION_RESPONSE_SCHEMA } from './products'
import type { ExtractionInput } from './products'

export interface ExtractionOptions {
  batchSize: number
  outputPath: string
}

function toExtractionInput(listing: Record<string, unknown>): ExtractionInput {
  const title = String(listing.marketplace_listing_title ?? listing.custom_title ?? '')
  const description = String((listing.redacted_description as { text?: string } | undefined)?.text ?? '')
  return { id: String(listing.id), title, description }
}

export async function runProductExtraction(
  gemini: GeminiClient,
  db: DbClient,
  logger: Logger,
  listings: Record<string, unknown>[],
  options: ExtractionOptions,
): Promise<Record<string, unknown>[]> {
  const pending = listings.filter((l) => !l.product_id)
  logger.info(`${listings.length} total listings, ${pending.length} pending product extraction`)

  for (let i = 0; i < pending.length; i += options.batchSize) {
    const batch = pending.slice(i, i + options.batchSize)
    const prompt = buildExtractionPrompt(batch.map(toExtractionInput))
    const raw = await gemini.generateJson(prompt, EXTRACTION_RESPONSE_SCHEMA)

    if (!Array.isArray(raw)) {
      logger.error(`batch starting at ${i}: unexpected response shape (not an array), skipping batch`)
      continue
    }

    for (const item of raw as { id?: unknown; base_model?: unknown }[]) {
      if (typeof item.id !== 'string' || typeof item.base_model !== 'string') continue
      const listing = listings.find((l) => String(l.id) === item.id)
      if (!listing) continue

      const productId = await findOrCreateProduct(db, item.base_model, null)
      listing.product_id = productId
      await db.query('UPDATE listings SET product_id = $1 WHERE id = $2', [productId, item.id])
      logger.info(`listing ${item.id} -> product ${productId} (${item.base_model})`)
    }
    saveListings(options.outputPath, listings)
  }

  return listings
}

async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
  const apiKey = process.env.FREE_GEMINI_API_KEY
  if (!apiKey) throw new Error('FREE_GEMINI_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — product extraction requires Postgres')

  const logger = createLogger('data/extract-products.log')
  const gemini = createGeminiClient(apiKey)
  const pool = createDbPool(dbUrl)
  const listings = loadListings('data/listings.jsonl')

  try {
    await runProductExtraction(gemini, pool, logger, listings, { batchSize: 25, outputPath: 'data/listings.jsonl' })
  } finally {
    await pool.end()
  }
  logger.info('product extraction complete')
}

// Guard so importing this module (e.g. from tests) doesn't also run main() —
// import.meta.main is unset under tsx, so compare resolved paths instead.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
