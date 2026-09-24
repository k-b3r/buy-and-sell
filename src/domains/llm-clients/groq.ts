import Groq from 'groq-sdk'

export interface GroqClient {
  generateJson(prompt: string, schema: object): Promise<unknown>
}

// Env var scheme changed 2026-09-03: single FREE_GROQ_API_KEY/ALT_FREE_GROQ_API_KEY/
// BACKFILL_FREE_GROQ_API_KEY replaced with numbered GROQ_API_KEY0, GROQ_API_KEY1, ...
// - same scheme as loadExaApiKeys - reads sequentially until the next index is
// unset, so the key pool can grow/shrink with no code change.
export function loadGroqApiKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys: string[] = []
  for (let i = 0; ; i++) {
    const key = env[`GROQ_API_KEY${i}`]
    if (!key) break
    keys.push(key)
  }
  return keys
}

export function createGroqClient(apiKey: string, model = 'openai/gpt-oss-120b'): GroqClient {
  const client = new Groq({ apiKey })
  return {
    async generateJson(prompt: string, schema: object): Promise<unknown> {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'response',
            strict: true,
            // groq-sdk types `schema` as `{ [key: string]: unknown }` (a Record),
            // not the plain `object` this client's public interface exposes —
            // confirmed via node_modules/groq-sdk/resources/chat/completions.d.ts.
            schema: schema as Record<string, unknown>,
          },
        },
      })
      const content = response.choices[0]?.message?.content
      if (!content) {
        throw new Error('Groq response contained no content')
      }
      return JSON.parse(content)
    },
  }
}

// Best-quality-first. A key's daily token quota is scoped per-model
// (confirmed live 2026-08-22 via the 429 body naming the specific model), so
// falling back to the next model on the same key buys extra headroom before
// that key is considered exhausted — but only after the strongest model
// available has been tried, never skipping ahead to save quota.
// qwen/qwen3.6-27b dropped 2026-09-24: Groq now 404s it ("does not exist or you
// do not have access to it"), so it only added a dead hop to every fallback.
export const GROQ_MODEL_FALLBACK_CHAIN = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'] as const

// One key, walked down GROQ_MODEL_FALLBACK_CHAIN on quota exhaustion.
export function createModelFallbackGroqClient(
  apiKey: string,
  models: readonly string[] = GROQ_MODEL_FALLBACK_CHAIN,
  onFallback?: (fromLabel: string, toLabel: string) => void,
): GroqClient {
  return createFallbackGroqClient(
    models.map((model) => createGroqClient(apiKey, model)),
    { labels: [...models], onFallback },
  )
}

export function isQuotaError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'status' in err && (err as { status?: unknown }).status === 429
}

// Groq's own error message is `${status} ${body}`, where body can be a huge
// JSON blob - e.g. a 400 json_validate_failed's `failed_generation` echoes
// back the model's entire (malformed) output. Callers that just want a
// one-line "what happened" for a log, not a dump, should log this instead of
// err.message directly.
export function summarizeGroqError(err: unknown, maxLength = 200): string {
  const message = err instanceof Error ? err.message : String(err)
  const oneLine = message.replace(/\s+/g, ' ').trim()
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}…` : oneLine
}

interface FallbackOptions {
  // Human-readable name per client, purely for logging (e.g. model names or
  // "GROQ_API_KEY0") - index-based ("client 0", "client 1") if omitted.
  labels?: string[]
  // Fired once, permanently, the moment a client is dropped for hitting its
  // quota - so a worker can log "falling back to X" without needing to know
  // isQuotaError or the rotation logic itself.
  onFallback?: (fromLabel: string, toLabel: string) => void
}

function labelFor(labels: string[] | undefined, index: number): string {
  return labels?.[index] ?? `client ${index}`
}

// Wraps multiple GroqClients (e.g. different models on the same key — Groq's
// daily token cap is scoped per-model, confirmed live 2026-08-22 via the real
// 429 body naming the specific model — so a different model has its own,
// untouched quota) and falls back to the next one the moment the current one
// hits a quota error (HTTP 429). The switch is permanent for the rest of the
// process. Any other kind of error (the occasional structural glitch, network
// failure, etc.) is not a quota signal and is rethrown immediately without
// switching — runProductEnrichment's own retry loop handles those.
export function createFallbackGroqClient(clients: GroqClient[], options: FallbackOptions = {}): GroqClient {
  let currentIndex = 0

  async function withFallback<T>(call: (client: GroqClient) => Promise<T>): Promise<T> {
    while (currentIndex < clients.length) {
      try {
        return await call(clients[currentIndex])
      } catch (err) {
        if (isQuotaError(err) && currentIndex < clients.length - 1) {
          const fromLabel = labelFor(options.labels, currentIndex)
          currentIndex += 1
          options.onFallback?.(fromLabel, labelFor(options.labels, currentIndex))
          continue
        }
        throw err
      }
    }
    throw new Error('all Groq clients exhausted')
  }

  return {
    generateJson: (prompt, schema) => withFallback((client) => client.generateJson(prompt, schema)),
  }
}

// Round-robins across multiple GroqClients (e.g. one per GROQ_API_KEY<n>) to
// spread load instead of hammering a single key. Same permanent-removal-on-
// quota-error behavior as createFallbackGroqClient, just selecting the next
// client to try by rotation instead of always starting from index 0 - so a
// key that hasn't hit its quota yet still gets its fair share of calls even
// after an earlier key in the list has failed over. Any other kind of error
// is not a quota signal and is rethrown immediately without rotating.
export function createRoundRobinGroqClient(clients: GroqClient[], options: FallbackOptions = {}): GroqClient {
  const pool = clients.map((client, index) => ({ client, label: labelFor(options.labels, index) }))
  let nextIndex = 0

  async function withRoundRobin<T>(call: (client: GroqClient) => Promise<T>): Promise<T> {
    while (pool.length > 0) {
      const index = nextIndex % pool.length
      try {
        const result = await call(pool[index].client)
        nextIndex = index + 1
        return result
      } catch (err) {
        if (isQuotaError(err) && pool.length > 1) {
          const [dropped] = pool.splice(index, 1)
          options.onFallback?.(dropped.label, pool[index % pool.length].label)
          continue
        }
        throw err
      }
    }
    throw new Error('all Groq clients exhausted')
  }

  return {
    generateJson: (prompt, schema) => withRoundRobin((client) => client.generateJson(prompt, schema)),
  }
}

// One-stop setup for a worker: builds a GroqClient per key (each walking
// GROQ_MODEL_FALLBACK_CHAIN, best model first, on its own quota exhaustion),
// then round-robins across keys so calls spread across all of them instead
// of hammering GROQ_API_KEY0 until it's dead. onFallback is wired to both
// levels (model-within-key, and key-to-key) so a worker can log every hop
// down the chain without duplicating this wiring itself.
export function createGroqPool(
  apiKeys: string[],
  onFallback?: (fromLabel: string, toLabel: string) => void,
  models: readonly string[] = GROQ_MODEL_FALLBACK_CHAIN,
): GroqClient {
  const keyLabels = apiKeys.map((_, i) => `GROQ_API_KEY${i}`)
  const perKeyClients = apiKeys.map((apiKey, i) =>
    createFallbackGroqClient(
      models.map((model) => createGroqClient(apiKey, model)),
      { labels: [...models], onFallback: (fromModel, toModel) => onFallback?.(`${keyLabels[i]}:${fromModel}`, `${keyLabels[i]}:${toModel}`) },
    ),
  )
  return createRoundRobinGroqClient(perKeyClients, { labels: keyLabels, onFallback })
}
