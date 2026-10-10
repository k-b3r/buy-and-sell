import { summarizeError } from '../errors'
import type { Logger } from '../logger'
import { loadSettings } from '../settings'
import type { DbClient } from '../storage'
import { errorStatus } from './error-classification'
import type { GroqRequestOptions } from './groq'

// Self-hosted FreeLLMAPI router (OpenAI-compatible, on the VPS at
// localhost:13001 behind llm.kber.dev). It pools free tiers from many
// providers and fails over between them itself, so one gateway client stands
// in for a whole key/model chain. Its Groq and Gemini keys are the same ones
// the workers hold directly, so it adds capacity only through the other
// providers. Grounded search goes through it too (2026-10-10, once the Groq and
// Gemini keys were moved into the gateway), pinned to Gemini models only: an
// unpinned router answer to a search question would be an ungrounded guess.

export interface GatewayConfig {
  baseUrl: string
  apiKey: string
  // Model ids from the gateway's /v1/models, tried in order. 'auto' (the
  // router's own pick) is always tried after them, so a pin that is rate
  // limited, retired or slow degrades to an unpinned call instead of failing.
  // An 'auto:<profile>' chain from the gateway dashboard works here too.
  models: string[]
  // Models that can run google_search, tried in order. Never falls back to
  // 'auto': a model without search would answer a price question from memory.
  groundedModels: string[]
}

export interface JsonClient {
  generateJson(prompt: string, schema: object): Promise<unknown>
}

export interface GatewayClient extends JsonClient {
  generateGroundedText(prompt: string): Promise<string>
}

const SETTING_KEY = 'llm.gateway_enabled'
// 0 = a gateway failure is an error, the worker's own Groq/Gemini client is
// never called. 1 (default) = it is the fallback, as before.
const FALLBACK_SETTING_KEY = 'llm.direct_fallback_enabled'
// Confirmed live 2026-10-10: all of these answered through the gateway's
// google provider (rate limited at the time of the test, but routed).
const DEFAULT_GROUNDED_MODELS = ['gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3.8-flash']
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
  const models = splitModels(raw)
  const grounded = splitModels(env.LLM_GATEWAY_GROUNDED_MODELS ?? '')
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    models: models.length > 0 ? models : [AUTO_MODEL],
    groundedModels: grounded.length > 0 ? grounded : DEFAULT_GROUNDED_MODELS,
  }
}

function splitModels(raw: string): string[] {
  return raw
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean)
}

// The router's own pick ('auto', or an 'auto:<profile>' chain), not a model id.
function isAutoModel(model: string): boolean {
  return model === AUTO_MODEL || model.startsWith(`${AUTO_MODEL}:`)
}

// A failure that says the gateway itself is struggling (rate limited, 5xx,
// timeout, network), as opposed to this one request being rejected (400, bad
// JSON), which must not shut the gateway off for every other call.
// A 429 only counts when `quotaCounts`: for grounded search it means Gemini's
// own free-tier quota is spent, which says nothing about the JSON calls that
// share this breaker.
function isGatewayOutage(err: unknown, quotaCounts: boolean): boolean {
  const status = errorStatus(err)
  if (status !== undefined) return (status === 429 && quotaCounts) || status >= 500
  return (
    err instanceof TypeError || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
  )
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

export function createGatewayClient(config: GatewayConfig, options: GatewayClientOptions = {}): GatewayClient {
  const fetchFn = options.fetchFn ?? fetch
  const { reasoningEffort, maxCompletionTokens } = options.requestOptions ?? {}
  const jsonChain = config.models.some(isAutoModel) ? config.models : [...config.models, AUTO_MODEL]
  let lastRoute: string | null = null

  function timeoutFor(model: string): number {
    const budget = options.timeoutMs ?? GATEWAY_TIMEOUT_MS
    return isAutoModel(model) ? budget : Math.min(budget, PINNED_TIMEOUT_MS)
  }

  // One chat completion; returns the message text.
  async function complete(model: string, prompt: string, extra: Record<string, unknown>): Promise<string> {
    const response = await fetchFn(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutFor(model)),
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], ...extra }),
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
    return content
  }

  // Each model in the chain once; the last error is the one thrown.
  async function runChain(chain: string[], call: (model: string) => Promise<string>): Promise<string> {
    let lastError: unknown
    for (const [i, model] of chain.entries()) {
      try {
        return await call(model)
      } catch (err) {
        lastError = err
        const next = chain[i + 1]
        if (next) options.onFallback?.(model, next, summarizeError(err))
      }
    }
    throw lastError
  }

  return {
    async generateJson(prompt: string, schema: object): Promise<unknown> {
      const extra = {
        response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema } },
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        ...(maxCompletionTokens ? { max_completion_tokens: maxCompletionTokens } : {}),
      }
      return JSON.parse(await runChain(jsonChain, (model) => complete(model, prompt, extra)))
    },
    // Google Search grounding can't be combined with a JSON schema (gemini.ts),
    // so this returns raw text for the caller to parse.
    generateGroundedText(prompt: string): Promise<string> {
      const extra = { tools: [{ type: 'function', function: { name: 'google_search', parameters: {} } }] }
      return runChain(config.groundedModels, (model) => complete(model, prompt, extra))
    },
  }
}

// Gateway-first LLM calls, with the worker's own direct client behind them for
// any gateway error (quota, bad JSON, container down), so the gateway can only
// add capacity, never stop a worker. Gated by the llm.gateway_enabled setting,
// read on every call so a dashboard flip applies immediately (same live-getter
// idea as the grounding cap in gemini.ts). llm.direct_fallback_enabled = 0
// removes that fallback: the direct Groq/Gemini client is then never called
// and a gateway failure is the caller's error, which its own retry or
// stop-and-resume logic already handles. No config (env unset) returns the
// direct client itself.
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

  async function viaGateway<T>(call: () => Promise<T>, fallback: () => Promise<T>, quotaCounts: boolean): Promise<T> {
    const settings = await loadSettings(deps.db, [SETTING_KEY, FALLBACK_SETTING_KEY])
    if (settings[SETTING_KEY] !== 1) return fallback()
    const directAllowed = settings[FALLBACK_SETTING_KEY] === 1
    if (breaker.isOpen()) {
      if (directAllowed) return fallback()
      throw Object.assign(new Error('LLM gateway is cooling down after a failure and the direct fallback is off'), {
        status: 503,
      })
    }
    try {
      return await call()
    } catch (err) {
      if (isGatewayOutage(err, quotaCounts)) breaker.trip()
      if (!directAllowed) throw err
      deps.logger.warn(`LLM gateway failed (${summarizeError(err)}), falling back to direct client`)
      return fallback()
    }
  }

  const grounded = (direct as Partial<GatewayClient>).generateGroundedText?.bind(direct)
  return {
    ...direct,
    generateJson: (prompt: string, schema: object): Promise<unknown> =>
      viaGateway(
        () => gateway.generateJson(prompt, schema),
        () => direct.generateJson(prompt, schema),
        true,
      ),
    ...(grounded
      ? {
          generateGroundedText: (prompt: string): Promise<string> =>
            viaGateway(
              () => gateway.generateGroundedText(prompt),
              () => grounded(prompt),
              false,
            ),
        }
      : {}),
  }
}
