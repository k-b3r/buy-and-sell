import { fileURLToPath } from 'node:url'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile } from '../../platform/env'
import { createGatewayClient, loadGatewayConfig } from '../../platform/llm-clients'
import type { TriageConfidence } from '../../modules/pricing'
import {
  applyTriageVerdicts,
  getTriageCandidates,
  getTriageSummary,
  runPriceTriage,
  saveTriageRows,
} from '../../modules/pricing'

// BUY-60. Default: triage excluded products via the LLM gateway into
// product_pricing_triage (resumable). --summary: verdict split for review.
// --apply [--min-confidence high|medium|low]: act on reviewed retry verdicts.
const ALL_PRODUCTS = 100_000
const CONFIDENCES: TriageConfidence[] = ['high', 'medium', 'low']

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env')
  const logger = { info: console.log, warn: console.warn, error: console.error }
  const pool = createDbPool(dbUrl)
  try {
    if (process.argv.includes('--summary')) {
      console.table(await getTriageSummary(pool))
    } else if (process.argv.includes('--apply')) {
      const min = (flagValue('--min-confidence') ?? 'high') as TriageConfidence
      if (!CONFIDENCES.includes(min)) throw new Error(`--min-confidence must be one of ${CONFIDENCES.join(', ')}`)
      logger.info(`included ${await applyTriageVerdicts(pool, min)} products in pricing (min confidence: ${min})`)
    } else {
      const config = loadGatewayConfig(process.env)
      if (!config) throw new Error('LLM_GATEWAY_URL / LLM_GATEWAY_API_KEY not set in .env')
      const llm = createGatewayClient(config, { onRoute: (route) => logger.info(`served by ${route}`) })
      const limit = Number(flagValue('--limit') ?? ALL_PRODUCTS)
      if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit must be a positive whole number')
      const candidates = await getTriageCandidates(pool, limit)
      await runPriceTriage({ llm, saveRows: (rows) => saveTriageRows(pool, rows), logger }, candidates)
    }
  } finally {
    await pool.end()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
