import { GoogleGenAI } from '@google/genai'

export interface GeminiClient {
  generateJson(prompt: string, schema: object): Promise<unknown>
  // Google Search grounding (tools: [{googleSearch}]) cannot be combined with
  // responseMimeType/responseSchema in the same request — confirmed live
  // (400 INVALID_ARGUMENT: "Tool use with a response mime type: 'application/json'
  // is unsupported"). So grounded calls get their own method, returning raw
  // text — the prompt is expected to ask for an easily-parseable trailing
  // line rather than relying on structured output.
  generateGroundedText(prompt: string): Promise<string>
}

export function createGeminiClient(apiKey: string, model = 'gemini-2.5-flash'): GeminiClient {
  const ai = new GoogleGenAI({ apiKey })
  return {
    async generateJson(prompt: string, schema: object): Promise<unknown> {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      })
      if (response.text === undefined) {
        throw new Error('Gemini response contained no text')
      }
      return JSON.parse(response.text)
    },
    async generateGroundedText(prompt: string): Promise<string> {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
        },
      })
      if (response.text === undefined) {
        throw new Error('Gemini response contained no text')
      }
      return response.text
    },
  }
}

const DEFAULT_DAILY_GROUNDING_CAP = 1000

// The 1,500/day free allowance + $35/1,000 overage described below is a
// *paid* (billing-enabled) key's terms. FREE_GEMINI_API_KEY here is a
// genuinely free, unbilled key - confirmed live 2026-09-02 by reproducing
// the actual failure directly: every call after the first 429'd with
// "generate_content_free_tier_requests... limit: 20, model: gemini-2.5-flash"
// (quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier) - a flat
// 20/day for the whole model, not grounding-specific, shared across every
// caller on this key (lookupRetail, lookupSecondhand, extract-products'
// generateJson). This 1,000 cap never actually engages on an unbilled key
// like this one - see createQuotaAwareGeminiClient below, which reacts to
// the real 429 instead of guessing a number. Kept here for a paid key,
// where the ceiling really is ~1,500 and does need a client-side guard
// (Google has no hard spend-stop of its own, just silent overage billing):

// Google Search grounding on gemini-2.5-flash is a paid-tier-only free
// allowance of 1,500 requests/day (confirmed live via ai.google.dev's
// pricing page, 2026-08-31) - RPD, not a monthly pool, resetting at
// midnight Pacific. Unlike a quota error elsewhere in this codebase,
// exceeding it on a paid (billed) key doesn't get rejected - Google just
// starts charging $35/1,000 overage, silently. There's no Google-side
// guardrail that actually stops spend (GCP's "budget alerts" only email
// you after the fact; a real hard "spend cap" exists in Preview as of
// 2026-07 but isn't confirmed available for this API yet) - so this cap is
// enforced client-side instead. 1,000 is a deliberate buffer under the real
// 1,500 ceiling, not the ceiling itself, per direct instruction (leaves
// room for reset-timing drift and any other process sharing the same
// billing project).
// limit can be a plain number (fixed for the process lifetime) or a live
// getter - the dashboard Settings page needs the latter so an operator's
// edit to discount_policy.gemini_daily_grounding_cap takes effect on the
// next call, not just the next process restart (this wrapper is normally
// constructed once at worker startup, long before any given call).
export function createDailyGroundingCap(
  client: GeminiClient,
  limit: number | (() => Promise<number>) = DEFAULT_DAILY_GROUNDING_CAP,
  now: () => Date = () => new Date(),
): GeminiClient {
  let dayKey = ''
  let count = 0

  // Google's RPD quotas reset at midnight Pacific Time, not UTC or the
  // server's local time - matching that boundary here so this cap and
  // Google's real quota never drift apart across time zones.
  function currentDayKey(): string {
    return now().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })
  }

  return {
    generateJson: (prompt, schema) => client.generateJson(prompt, schema),
    async generateGroundedText(prompt: string): Promise<string> {
      const resolvedLimit = typeof limit === 'function' ? await limit() : limit
      const today = currentDayKey()
      if (today !== dayKey) {
        dayKey = today
        count = 0
      }
      if (count >= resolvedLimit) {
        throw new Error(
          `Gemini grounded-search daily cap (${resolvedLimit}) reached for ${dayKey} - refusing further calls to avoid billing overage`,
        )
      }
      count += 1
      return client.generateGroundedText(prompt)
    },
  }
}

export function isQuotaError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'status' in err && (err as { status?: unknown }).status === 429
}

// Reacts to Google's real 429 instead of guessing a request count (see the
// comment above createDailyGroundingCap - this unbilled key's true ceiling
// is a flat 20/day, confirmed live, not the 1,500 that cap's default was
// built around). Once a 429 is seen, every subsequent generateGroundedText
// call this same day short-circuits locally instead of spending a network
// round-trip on a call already known to fail - lookupRetail/lookupSecondhand
// (price-lookup.ts) fall through to Exa immediately on any thrown error, so
// this just makes that fallback instant instead of waiting on a doomed
// request first. Resets at midnight Pacific, same boundary
// createDailyGroundingCap uses, since that's when Google's own quota resets.
export function createQuotaAwareGeminiClient(client: GeminiClient, now: () => Date = () => new Date()): GeminiClient {
  let dayKey = ''
  let exhausted = false

  function currentDayKey(): string {
    return now().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })
  }

  return {
    generateJson: (prompt, schema) => client.generateJson(prompt, schema),
    async generateGroundedText(prompt: string): Promise<string> {
      const today = currentDayKey()
      if (today !== dayKey) {
        dayKey = today
        exhausted = false
      }
      if (exhausted) {
        throw new Error(
          `Gemini free-tier daily quota already confirmed exhausted for ${dayKey} - skipping straight to the next provider`,
        )
      }
      try {
        return await client.generateGroundedText(prompt)
      } catch (err) {
        if (isQuotaError(err)) exhausted = true
        throw err
      }
    },
  }
}

// Wraps multiple GeminiClients (e.g. free-tier keys from different accounts,
// each with its own independent daily quota) and falls back to the next one
// the moment the current one hits a quota error (HTTP 429). The switch is
// permanent for the rest of the process — once a client's quota is known to
// be exhausted, there's no reason to try it again this run. Any other kind
// of error (malformed response, network failure, etc.) is not a quota
// signal and is rethrown immediately without switching.
export function createFallbackGeminiClient(clients: GeminiClient[]): GeminiClient {
  let currentIndex = 0

  async function withFallback<T>(call: (client: GeminiClient) => Promise<T>): Promise<T> {
    while (currentIndex < clients.length) {
      try {
        return await call(clients[currentIndex])
      } catch (err) {
        if (isQuotaError(err) && currentIndex < clients.length - 1) {
          currentIndex += 1
          continue
        }
        throw err
      }
    }
    throw new Error('all Gemini clients exhausted')
  }

  return {
    generateJson: (prompt, schema) => withFallback((client) => client.generateJson(prompt, schema)),
    generateGroundedText: (prompt) => withFallback((client) => client.generateGroundedText(prompt)),
  }
}
