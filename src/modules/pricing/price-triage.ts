import type { DelayFn } from '../../platform/delay'
import { realDelay } from '../../platform/delay'
import type { Logger } from '../../platform/logger'
import { QuotaExhaustedError, RetriesExhaustedError, withRetry } from '../../platform/llm-clients'
import { toNullableNumber } from '../../platform/rows'
import type { DbClient } from '../../platform/storage'
import { includeInPricing } from './exclusion'

// One-off LLM triage of products excluded from price lookup (BUY-60): per
// product a verdict (retry the lookup or keep it excluded) plus a rough
// new-retail estimate, logged to product_pricing_triage. Nothing changes
// pricing until a human reviews the log and runs applyTriageVerdicts.

// Confirmed live 2026-10-08: a 20-product batch on the gateway's `auto` route
// hit a 60s provider timeout (and Cloudflare's 100s cap in front of
// llm.kber.dev); 10 per batch ran 40 products in 16s via gpt-oss-120b.
const DEFAULT_BATCH_SIZE = 10
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 5000
const MAX_SAMPLE_TITLES = 3

export interface TriageCandidate {
  id: number
  base_model: string
  variant_tier: string | null
  category: string | null
  description: string | null
  reason: string
  listing_count: number
  median_ask: number | null
  sample_titles: string[]
}

type Verdict = 'retry' | 'keep_excluded'
export type TriageConfidence = 'high' | 'medium' | 'low'

export interface TriageRow {
  productId: number
  previousReason: string
  verdict: Verdict
  isSpecificProduct: boolean
  confidence: TriageConfidence
  priceLow: number | null
  priceHigh: number | null
  reasoning: string
}

const TRIAGE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          product_id: { type: 'integer' },
          verdict: { type: 'string', enum: ['retry', 'keep_excluded'] },
          is_specific_product: { type: 'boolean' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          price_low_php: { type: ['number', 'null'] },
          price_high_php: { type: ['number', 'null'] },
          reasoning: { type: 'string' },
        },
        required: [
          'product_id',
          'verdict',
          'is_specific_product',
          'confidence',
          'price_low_php',
          'price_high_php',
          'reasoning',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
}

export function buildTriagePrompt(batch: TriageCandidate[]): string {
  const products = batch.map((c) => ({
    id: c.id,
    name: c.variant_tier ? `${c.base_model} ${c.variant_tier}` : c.base_model,
    category: c.category,
    description: c.description,
    reason: c.reason,
    listing_count: c.listing_count,
    median_ask_php: c.median_ask,
    sample_titles: c.sample_titles,
  }))
  return `You triage products from a Philippine secondhand marketplace (Facebook Marketplace) that our price lookup has excluded. For each product:

- verdict: "retry" if the name identifies one real, specific product (brand and model level) whose brand-new retail price a web search could find. "keep_excluded" if it is too generic (e.g. "Aircon", "Bag"), a part or accessory bundle, real estate, a service, or not a real product.
- is_specific_product and confidence ("high", "medium" or "low") for that judgment.
- price_low_php / price_high_php: your best estimate of the brand-new retail price range in the Philippines, in PHP, from your own knowledge. null for both if you don't know or it isn't a specific product.
- reasoning: one short sentence.

"reason" is why it was excluded. retail_not_found: a recent web price search found nothing. exa_no_result, exa_wide_spread, exa_low_confidence, claude_no_result: an older web search found nothing or only conflicting prices, which is evidence the product is too generic or does not exist; say "retry" for those only when the name is clearly a real specific model. Other reasons are earlier judgments (by an AI, a keyword rule or a curated list) that you may overturn with good evidence. sample_titles and median_ask_php show what sellers actually list under this name.

Return one result per product, keyed by product_id.

Products:
${JSON.stringify(products)}`
}

const VERDICTS = new Set(['retry', 'keep_excluded'])
const CONFIDENCES = new Set(['high', 'medium', 'low'])

type ParsedItem =
  { kind: 'ok'; row: TriageRow } | { kind: 'malformed'; idHint: string } | { kind: 'unknown-candidate'; id: number }

// An estimate only counts as a usable range: both ends present, positive, low <= high.
function priceRange(low: unknown, high: unknown): { priceLow: number | null; priceHigh: number | null } {
  if (typeof low !== 'number' || typeof high !== 'number' || low <= 0 || low > high) {
    return { priceLow: null, priceHigh: null }
  }
  return { priceLow: low, priceHigh: high }
}

export function parseTriageItem(raw: unknown, batch: TriageCandidate[]): ParsedItem {
  const item = (raw ?? {}) as Record<string, unknown>
  const id = item.product_id
  if (
    typeof id !== 'number' ||
    typeof item.verdict !== 'string' ||
    !VERDICTS.has(item.verdict) ||
    typeof item.is_specific_product !== 'boolean' ||
    typeof item.confidence !== 'string' ||
    !CONFIDENCES.has(item.confidence) ||
    typeof item.reasoning !== 'string'
  ) {
    return { kind: 'malformed', idHint: String(id) }
  }
  const candidate = batch.find((c) => c.id === id)
  if (!candidate) return { kind: 'unknown-candidate', id }
  return {
    kind: 'ok',
    row: {
      productId: id,
      previousReason: candidate.reason,
      verdict: item.verdict as Verdict,
      isSpecificProduct: item.is_specific_product,
      confidence: item.confidence as TriageConfidence,
      ...priceRange(item.price_low_php, item.price_high_php),
      reasoning: item.reasoning,
    },
  }
}

interface TriageIo {
  llm: { generateJson(prompt: string, schema: object): Promise<unknown> }
  saveRows: (rows: TriageRow[]) => Promise<void>
  logger: Logger
  delay?: DelayFn
}

// Triage in batches; stops cleanly when the gateway is exhausted or keeps
// failing. Rerunning resumes: saved products drop out of getTriageCandidates.
export async function runPriceTriage(
  { llm, saveRows, logger, delay = realDelay }: TriageIo,
  candidates: TriageCandidate[],
  { batchSize = DEFAULT_BATCH_SIZE }: { batchSize?: number } = {},
): Promise<void> {
  logger.info(`${candidates.length} excluded products to triage`)
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize)
    const label = `batch starting at ${i}`
    let raw: unknown
    try {
      raw = await withRetry(() => llm.generateJson(buildTriagePrompt(batch), TRIAGE_RESPONSE_SCHEMA), {
        provider: 'LLM gateway',
        label,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        retryDelayMs: DEFAULT_RETRY_DELAY_MS,
        delay,
        logger,
      })
    } catch (err) {
      if (!(err instanceof QuotaExhaustedError || err instanceof RetriesExhaustedError)) throw err
      logger.error(`${label}: LLM gateway unavailable (${err.message}), stopping run; rerun to resume`)
      return
    }
    const results = (raw as { results?: unknown } | undefined)?.results
    if (!Array.isArray(results)) {
      logger.error(`${label}: unexpected response shape (no results array), skipping batch`)
      continue
    }
    const rows: TriageRow[] = []
    for (const item of results) {
      const parsed = parseTriageItem(item, batch)
      if (parsed.kind === 'ok') rows.push(parsed.row)
      else
        logger.warn(
          `${label}: item ${parsed.kind === 'malformed' ? parsed.idHint : parsed.id} ${parsed.kind}, skipping`,
        )
    }
    await saveRows(rows)
    logger.info(`${label}: saved ${rows.length}/${batch.length} verdicts`)
  }
}

// Excluded products not yet triaged, most listings first.
export async function getTriageCandidates(db: DbClient, limit: number): Promise<TriageCandidate[]> {
  const result = (await db.query(
    `SELECT p.id, p.base_model, p.variant_tier, c.name AS category, e.description,
            COALESCE(p.price_lookup_excluded_reason, 'unknown') AS reason,
            count(l.id)::int AS listing_count,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY l.price_amount) AS median_ask,
            (array_agg(l.title ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL))[1:${MAX_SAMPLE_TITLES}] AS sample_titles
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN product_enrichment e ON e.product_id = p.id
     LEFT JOIN listings l ON l.product_id = p.id
     WHERE p.price_lookup_excluded
       AND NOT EXISTS (SELECT 1 FROM product_pricing_triage t WHERE t.product_id = p.id)
     GROUP BY p.id, c.name, e.description
     ORDER BY listing_count DESC, p.id
     LIMIT $1`,
    [limit],
  )) as { rows: Record<string, unknown>[] }
  return result.rows.map((r) => ({
    id: r.id as number,
    base_model: r.base_model as string,
    variant_tier: r.variant_tier as string | null,
    category: r.category as string | null,
    description: r.description as string | null,
    reason: r.reason as string,
    listing_count: r.listing_count as number,
    median_ask: toNullableNumber(r.median_ask),
    sample_titles: (r.sample_titles as string[] | null) ?? [],
  }))
}

// Re-triaging a product replaces its verdict and resets its applied mark.
export async function saveTriageRows(db: DbClient, rows: TriageRow[]): Promise<void> {
  for (const r of rows) {
    await db.query(
      `INSERT INTO product_pricing_triage
         (product_id, previous_reason, verdict, is_specific_product, confidence, price_low, price_high, reasoning)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (product_id) DO UPDATE SET
         previous_reason = EXCLUDED.previous_reason, verdict = EXCLUDED.verdict,
         is_specific_product = EXCLUDED.is_specific_product, confidence = EXCLUDED.confidence,
         price_low = EXCLUDED.price_low, price_high = EXCLUDED.price_high, reasoning = EXCLUDED.reasoning,
         triaged_at = now(), applied_at = NULL`,
      [
        r.productId,
        r.previousReason,
        r.verdict,
        r.isSpecificProduct,
        r.confidence,
        r.priceLow,
        r.priceHigh,
        r.reasoning,
      ],
    )
  }
}

const CONFIDENCE_RANK: Record<TriageConfidence, number> = { low: 1, medium: 2, high: 3 }

// A typo'd reason would otherwise match nothing and look like a clean run.
async function assertKnownReasons(db: DbClient, reasons: string[]): Promise<void> {
  const result = (await db.query('SELECT DISTINCT previous_reason FROM product_pricing_triage', [])) as {
    rows: { previous_reason: string }[]
  }
  const known = new Set(result.rows.map((r) => r.previous_reason))
  const unknown = reasons.filter((r) => !known.has(r))
  if (unknown.length > 0) {
    throw new Error(`unknown reason(s): ${unknown.join(', ')}. Triaged reasons: ${[...known].sort().join(', ')}`)
  }
}

// The reviewed step: every unapplied "retry" verdict at or above minConfidence
// goes through includeInPricing (BUY-36: retry for failed searches, override
// for judgments). Idempotent: applied_at marks what's done. A crash between
// the include and the applied_at write is safe: the next run re-includes, and
// includeInPricing leaves an already-included product alone. Returns the count.
// `reasons` limits it to products whose old exclusion reason is listed (the
// reviewed groups); omitted means every reason. A human's manual_review
// exclusion is never overturned, listed or not.
export async function applyTriageVerdicts(
  db: DbClient,
  minConfidence: TriageConfidence,
  reasons?: string[],
): Promise<number> {
  if (reasons) await assertKnownReasons(db, reasons)
  const result = (await db.query(
    `SELECT product_id FROM product_pricing_triage
     WHERE verdict = 'retry' AND applied_at IS NULL
       AND CASE confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END >= $1
       AND previous_reason <> 'manual_review'
       AND ($2::text[] IS NULL OR previous_reason = ANY($2))
     ORDER BY product_id`,
    [CONFIDENCE_RANK[minConfidence], reasons ?? null],
  )) as { rows: { product_id: number }[] }
  for (const { product_id } of result.rows) {
    await includeInPricing(db, product_id)
    await db.query('UPDATE product_pricing_triage SET applied_at = now() WHERE product_id = $1', [product_id])
  }
  return result.rows.length
}

export interface TriageSummaryRow {
  previous_reason: string
  verdict: string
  confidence: string
  count: number
}

// What a review looks at before applying: verdict split per old reason.
export async function getTriageSummary(db: DbClient): Promise<TriageSummaryRow[]> {
  const result = (await db.query(
    `SELECT previous_reason, verdict, confidence, count(*)::int AS count
     FROM product_pricing_triage WHERE applied_at IS NULL
     GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
    [],
  )) as { rows: TriageSummaryRow[] }
  return result.rows
}
