import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Logger } from './logger'
import { createLogger } from './logger'
import type { GeminiClient } from './gemini'
import { createGeminiClient } from './gemini'
import type { DbClient } from './db'
import { createDbPool, findOrCreateProduct } from './db'
import { loadListings, saveListings } from './jsonl'
import { buildVariantPrompt, buildVariantSchema } from './products'
import type { ExtractionInput } from './products'

export interface VariantClassifyOptions {
  outputPath: string
}

function toExtractionInput(listing: Record<string, unknown>): ExtractionInput {
  const title = String(listing.marketplace_listing_title ?? listing.custom_title ?? '')
  const description = String((listing.redacted_description as { text?: string } | undefined)?.text ?? '')
  return { id: String(listing.id), title, description }
}

export async function runVariantClassification(
  gemini: GeminiClient,
  db: DbClient,
  logger: Logger,
  listings: Record<string, unknown>[],
  baseModel: string,
  enumValues: string[],
  productId: number,
  options: VariantClassifyOptions,
): Promise<Record<string, unknown>[]> {
  const targets = listings.filter((l) => l.product_id === productId)
  logger.info(`${targets.length} listings under product ${productId} (${baseModel}) to classify`)
  if (targets.length === 0) return listings

  const prompt = buildVariantPrompt(baseModel, enumValues, targets.map(toExtractionInput))
  const schema = buildVariantSchema(enumValues)
  const raw = await gemini.generateJson(prompt, schema)

  if (!Array.isArray(raw)) {
    logger.error(`unexpected response shape for product ${productId} (${baseModel}), skipping`)
    return listings
  }

  for (const item of raw as { id?: unknown; variant_tier?: unknown }[]) {
    if (typeof item.id !== 'string' || typeof item.variant_tier !== 'string') continue
    const listing = listings.find((l) => String(l.id) === item.id)
    if (!listing) continue

    const newProductId = await findOrCreateProduct(db, baseModel, item.variant_tier)
    listing.product_id = newProductId
    await db.query('UPDATE listings SET product_id = $1 WHERE id = $2', [newProductId, item.id])
    logger.info(`listing ${item.id} -> product ${newProductId} (${baseModel}, ${item.variant_tier})`)
  }
  saveListings(options.outputPath, listings)

  return listings
}

async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
  const apiKey = process.env.FREE_GEMINI_API_KEY
  if (!apiKey) throw new Error('FREE_GEMINI_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env')

  const logger = createLogger('data/variant-classify.log')
  const gemini = createGeminiClient(apiKey)
  const pool = createDbPool(dbUrl)
  const listings = loadListings('data/listings.jsonl')

  try {
    const enumsResult = (await pool.query('SELECT base_model_normalized, enum_values FROM variant_enums', [])) as {
      rows: { base_model_normalized: string; enum_values: string[] }[]
    }
    const productsResult = (await pool.query(
      'SELECT id, base_model, base_model_normalized FROM products WHERE variant_tier IS NULL',
      [],
    )) as { rows: { id: number; base_model: string; base_model_normalized: string }[] }

    for (const enumRow of enumsResult.rows) {
      const product = productsResult.rows.find((p) => p.base_model_normalized === enumRow.base_model_normalized)
      if (!product) {
        logger.warn(`variant_enums row for "${enumRow.base_model_normalized}" has no matching un-split product, skipping`)
        continue
      }
      await runVariantClassification(gemini, pool, logger, listings, product.base_model, enumRow.enum_values, product.id, {
        outputPath: 'data/listings.jsonl',
      })
    }
  } finally {
    await pool.end()
  }
  logger.info('variant classification complete')
}

// Guard so importing this module (e.g. from tests) doesn't also run main() —
// import.meta.main is unset under tsx, so compare resolved paths instead.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
