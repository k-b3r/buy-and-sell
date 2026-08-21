import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Logger } from './logger'
import { createLogger } from './logger'
import type { GroqClient } from './groq'
import { createGroqClient } from './groq'
import type { DbClient } from './db'
import { createDbPool, getEnrichmentCandidates, upsertProductEnrichment } from './db'
import { buildEnrichmentPrompt, ENRICHMENT_RESPONSE_SCHEMA } from './enrichment'
import type { EnrichmentCandidate } from './enrichment'

const BATCH_SIZE = 35
const MODEL = 'openai/gpt-oss-120b'

interface RawEnrichmentItem {
  id?: unknown
  description?: unknown
  value_drivers?: unknown
  has_trained_price_knowledge?: unknown
  trained_price_low?: unknown
  trained_price_high?: unknown
}

export async function runProductEnrichment(
  groq: GroqClient,
  db: DbClient,
  logger: Logger,
  candidates: EnrichmentCandidate[],
): Promise<void> {
  logger.info(`${candidates.length} products to enrich`)

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE)
    const prompt = buildEnrichmentPrompt(batch)
    const raw = (await groq.generateJson(prompt, ENRICHMENT_RESPONSE_SCHEMA)) as { results?: unknown }

    if (!raw || !Array.isArray(raw.results)) {
      logger.error(`batch starting at ${i}: unexpected response shape (no results array), skipping batch`)
      continue
    }

    for (const item of raw.results as RawEnrichmentItem[]) {
      if (
        typeof item.id !== 'string' ||
        typeof item.description !== 'string' ||
        typeof item.value_drivers !== 'string' ||
        typeof item.has_trained_price_knowledge !== 'boolean'
      ) {
        continue
      }
      const candidate = batch.find((c) => String(c.id) === item.id)
      if (!candidate) continue

      const trainedPriceLow = typeof item.trained_price_low === 'number' ? item.trained_price_low : null
      const trainedPriceHigh = typeof item.trained_price_high === 'number' ? item.trained_price_high : null

      await upsertProductEnrichment(
        db,
        candidate.id,
        {
          description: item.description,
          valueDrivers: item.value_drivers,
          hasTrainedPriceKnowledge: item.has_trained_price_knowledge,
          trainedPriceLow,
          trainedPriceHigh,
        },
        MODEL,
      )
      logger.info(`product ${candidate.id} enriched (trained price known: ${item.has_trained_price_knowledge})`)
    }
  }
}

async function main() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env')
  }
  const apiKey = process.env.FREE_GROQ_API_KEY
  if (!apiKey) throw new Error('FREE_GROQ_API_KEY not set in .env')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env — product enrichment requires Postgres')

  const logger = createLogger('data/enrich-products.log')
  const groq = createGroqClient(apiKey)
  const pool = createDbPool(dbUrl)

  try {
    const candidates = await getEnrichmentCandidates(pool)
    await runProductEnrichment(groq, pool, logger, candidates)
  } finally {
    await pool.end()
  }
  logger.info('product enrichment complete')
}

// Guard so importing this module (e.g. from tests) doesn't also run main() —
// import.meta.main is unset under tsx, so compare resolved paths instead.
// (extract-products.ts hit this exact bug: importing its exported function
// for tests triggered a live main() run against real credentials.)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
