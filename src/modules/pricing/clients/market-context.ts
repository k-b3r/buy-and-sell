import { buildPriceQuery } from '../prompts/discount-verification.prompt'
import type { DiscountVerificationCandidate, VerificationClients } from '../types'

const EXA_SUMMARY_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
} as const

// Tries Exa first, then Tavily, then Gemini grounding — first provider to
// return real (non-empty) text wins. A provider that errors or comes back
// empty falls through to the next one rather than failing the whole
// candidate; only exhausting all three means "no fresh data available right
// now." Exa-first (not Tavily-first) per a live head-to-head comparison
// (2026-08-31, 15 real candidates): Exa cited sources and abstained honestly
// when it lacked real secondhand data, where Tavily confidently fabricated
// numbers with no citation trail - caught concretely wrong Tavily answers
// (a "secondhand" price higher than Exa's own cited new-retail price on a
// monitor; a raw USD figure returned for a PHP-scoped query on a watch).
// Exa costs ~$0.007/call vs Tavily's free tier, but this worker's own
// verify_discount.lap_limit_default (3 candidates/lap by default) keeps
// that cost trivial - accuracy matters more here since this gates a real
// buy decision.
export async function fetchFreshMarketContext(
  candidate: DiscountVerificationCandidate,
  clients: Pick<VerificationClients, 'tavily' | 'exa' | 'gemini'>,
): Promise<{ text: string; source: string } | null> {
  const query = buildPriceQuery(candidate)

  try {
    const exaResult = (await clients.exa.searchStructured(
      query,
      'Summarize the current market price context.',
      EXA_SUMMARY_SCHEMA,
    )) as {
      output?: { content?: { summary?: string } }
    }
    const summary = exaResult.output?.content?.summary
    if (summary && summary.trim().length > 0) return { text: summary, source: 'exa' }
  } catch {
    // fall through to Tavily
  }

  try {
    const tavilyResult = await clients.tavily.search(query)
    const text = tavilyResult.answer ?? tavilyResult.results.map((r) => r.content).join('\n')
    if (text.trim().length > 0) return { text, source: 'tavily' }
  } catch {
    // fall through to Gemini
  }

  try {
    const text = await clients.gemini.generateGroundedText(`Search for the ${query}. Summarize what you find.`)
    if (text.trim().length > 0) return { text, source: 'gemini_grounding' }
  } catch {
    // all three exhausted
  }

  return null
}
