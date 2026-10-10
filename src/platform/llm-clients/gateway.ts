import { summarizeError } from '../errors'
import type { Logger } from '../logger'
import { loadSettings } from '../settings'
import type { DbClient } from '../storage'
import type { GroqRequestOptions } from './groq'

// Self-hosted FreeLLMAPI router (OpenAI-compatible, on the VPS at
// localhost:13001 behind llm.kber.dev). It pools free tiers from many
// providers and fails over between them itself, so one gateway client stands
// in for a whole key/model chain. Its Groq and Gemini keys are the same ones
// the workers hold directly, so it adds capacity only through the other
// providers. Grounded search stays direct: confirmed live 2026-10-07, the
// gateway's google_search tool only reaches those same two Gemini keys.

export interface GatewayConfig {
  baseUrl: string
  apiKey: string
  // Model ids from the gateway's /v1/models, tried in order. 'auto' (the
  // router's own pick) is always tried after them, so a pin that is rate
  // limited, retired or slow degrades to an unpinned call instead of failing.
  // An 'auto:<profile>' chain from the gateway dashboard works here too.
  models: string[]
}

export interface JsonClient {
  generateJson(prompt: string, schema: object): Promise<unknown>
}

const SETTING_KEY = 'llm.gateway_enabled'
// A gateway that accepts the connection but never answers would otherwise
// hang the worker, since the direct-client fallback only runs on an error.
const GATEWAY_TIMEOUT_MS = 120_000
// Confirmed live 2026-10-10: pinned models answered strict JSON in 0.2-3.6s
// while an unpinned call took 12.6s, so a pin that hangs is cut short and the
// call moves on, leaving the full budget for the unpinned attempt.
const PINNED_TIMEOUT_MS = 45_000
const AUTO_MODEL = 'auto'
// After every attempt in the chain fails, skip the gateway this long. Without
// it each call during an outage waits out its timeouts before the direct client.
const BREAKER_COOLDOWN_MS = 60_000

// `worker` (a worker's folder name) selects LLM_GATEWAY_MODEL_<WORKER> over the
// global LLM_GATEWAY_MODEL, so the stricter judges can pin a stronger model.
export function loadGatewayConfig(env: NodeJS.ProcessEnv, worker?: string): GatewayConfig | null {
  const baseUrl = env.LLM_GATEWAY_URL
  const apiKey = env.LLM_GATEWAY_API_KEY
  if (!baseUrl || !apiKey) return null
  const workerKey = worker ? `LLM_GATEWAY_MODEL_${worker.toUpperCase().replace(/-/g, '_')}` : null
  const raw = (workerKey && env[workerKey]) || env.LLM_GATEWAY_MODEL || ''
  const models = raw
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, models: models.length > 0 ? models : [AUTO_MODEL] }
}

export interface GatewayBreaker {
  isOpen(): boolean
  trip(): void
}

// Shared by every withGateway wrapper of one worker, so a gateway that is down
// is tried once per cooldown rather than once per wrapped client per call.
export function createGatewayBreaker({
  now = Date.now,
  cooldownMs = BREAKER_COOLDOWN_MS,
}: { now?: () => number; cooldownMs?: number } = {}): GatewayBreaker {
  let openUntil = 0
  return {
    isOpen: () => now() < openUntil,
    trip: () => {
      openUntil = now() + cooldownMs
    },
  }
}

interface GatewayClientOptions {
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>
  requestOptions?: GroqRequestOptions
  timeoutMs?: number
  // Called with the X-Routed-Via header ("<platform>/<model>") whenever it
  // differs from the previous answered call's, so a log shows each switch, not every call.
  onRoute?: (route: string) => void
  // Called when a model in the chain fails and the next one is tried.
  onFallback?: (from: string, to: string, reason: string) => void
}

export function createGatewayClient(config: GatewayConfig, options: GatewayClientOptions = {}): JsonClient {
  const fetchFn = options.fetchFn ?? fetch
  const { reasoningEffort, maxCompletionTokens } = options.requestOptions ?? {}
  const chain = config.models.some((m) => m.startsWith(AUTO_MODEL)) ? config.models : [...config.models, AUTO_MODEL]
  let lastRoute: string | null = null

  function timeoutFor(model: string): number {
    const budget = options.timeoutMs ?? GATEWAY_TIMEOUT_MS
    return model.startsWith(AUTO_MODEL) ? budget : Math.min(budget, PINNED_TIMEOUT_MS)
  }

  async function requestOnce(model: string, prompt: string, schema: object): Promise<unknown> {
    const response = await fetchFn(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutFor(model)),
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema } },
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(maxCompletionTokens ? { max_completion_tokens: maxCompletionTokens } : {}),
      }),
    })
    if (!response.ok) {
      const body = await response.text()
      throw Object.assign(new Error(`LLM gateway request failed: ${response.status} ${body}`), {
        status: response.status,
      })
    }
    const route = response.headers.get('x-routed-via')
    if (route && route !== lastRoute) {
      lastRoute = route
      options.onRoute?.(route)
    }
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] }
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error('LLM gateway response contained no content')
    return JSON.parse(content)
  }

  return {
    // Each model in the chain once; the last error is the one thrown.
    async generateJson(prompt: string, schema: object): Promise<unknown> {
      let lastError: unknown
      for (const [i, model] of chain.entries()) {
        try {
          return await requestOnce(model, prompt, schema)
        } catch (err) {
          lastError = err
          const next = chain[i + 1]
          if (next) options.onFallback?.(model, next, summarizeError(err))
        }
      }
      throw lastError
    },
  }
}

// Gateway-first generateJson, with the worker's own direct client as the
// fallback for any gateway error (quota, bad JSON, container down), so the
// gateway can only add capacity, never stop a worker. Gated by the
// llm.gateway_enabled setting, read on every call so a dashboard flip applies
// immediately (same live-getter idea as the grounding cap in gemini.ts).
// Every other method of the direct client passes through untouched. No
// config (env unset) returns the direct client itself.
export function withGateway<C extends JsonClient>(
  direct: C,
  config: GatewayConfig | null,
  deps: { db: DbClient; logger: Logger; breaker?: GatewayBreaker } & Omit<
    GatewayClientOptions,
    'onRoute' | 'onFallback'
  >,
): C {
  if (!config) return direct
  const breaker = deps.breaker ?? createGatewayBreaker()
  const gateway = createGatewayClient(config, {
    fetchFn: deps.fetchFn,
    requestOptions: deps.requestOptions,
    timeoutMs: deps.timeoutMs,
    onRoute: (route) => deps.logger.info(`LLM gateway now served by ${route}`),
    onFallback: (from, to, reason) => deps.logger.warn(`LLM gateway ${from} failed (${reason}), trying ${to}`),
  })
  return {
    ...direct,
    async generateJson(prompt: string, schema: object): Promise<unknown> {
      const settings = await loadSettings(deps.db, [SETTING_KEY])
      if (settings[SETTING_KEY] !== 1 || breaker.isOpen()) return direct.generateJson(prompt, schema)
      try {
        return await gateway.generateJson(prompt, schema)
      } catch (err) {
        breaker.trip()
        deps.logger.warn(`LLM gateway failed (${summarizeError(err)}), falling back to direct client`)
        return direct.generateJson(prompt, schema)
      }
    },
  }
}
