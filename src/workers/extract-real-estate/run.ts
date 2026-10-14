import type { Logger } from '../../platform/logger'
import type { DbClient } from '../../platform/storage'
import type { DelayFn } from '../../platform/delay'
import { realDelay } from '../../platform/delay'
import { QuotaExhaustedError } from '../../platform/llm-clients'
import type { JsonModelClient, RealEstateCandidate, RealEstateFields } from '../../modules/real-estate'
import { extractRealEstateBatch, upsertRealEstateDetails } from '../../modules/real-estate'

const MODEL = 'openai/gpt-oss-120b'

export async function runRealEstateExtraction(
  deps: { groq: JsonModelClient; db: DbClient; logger: Logger; delay?: DelayFn },
  candidates: RealEstateCandidate[],
  batchSize = 10,
): Promise<void> {
  const { groq, db, logger, delay = realDelay } = deps
  logger.info(`${candidates.length} real estate listings to extract`)
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize)
    let extracted: Map<string, RealEstateFields>
    try {
      extracted = await extractRealEstateBatch({ groq, logger, delay }, batch)
    } catch (err) {
      if (!(err instanceof QuotaExhaustedError)) throw err
      logger.error(`Groq quota exhausted (${err.message}), stopping run`)
      return
    }
    for (const candidate of batch) {
      const fields = extracted.get(candidate.id)
      if (!fields) continue
      await upsertRealEstateDetails(db, {
        listingId: candidate.id,
        fields,
        model: MODEL,
        sourceHash: candidate.source_hash,
      })
      logger.info(
        `listing ${candidate.id} extracted (${fields.property_type}, price basis ${fields.price_basis}, ${fields.confidence})`,
      )
    }
  }
}
