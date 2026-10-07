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
  // 'auto', an 'auto:<profile>' chain from the gateway dashboard, or a pinned model id.
  model: string
}

export interface JsonClient {
  generateJson(prompt: string, schema: object): Promise<unknown>
}

const SETTING_KEY = 'llm.gateway_enabled'

export function loadGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig | null {
  const baseUrl = env.LLM_GATEWAY_URL
  const apiKey = env.LLM_GATEWAY_API_KEY
  if (!baseUrl || !apiKey) return null
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model: env.LLM_GATEWAY_MODEL || 'auto' }
}

interface GatewayClientOptions {
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>
  requestOptions?: GroqRequestOptions
  // Called with the X-Routed-Via header ("<platform>/<model>") whenever it
  // differs from the previous answered call's, so a log shows each switch, not every call.
  onRoute?: (route: string) => void
}

export function createGatewayClient(config: GatewayConfig, options: GatewayClientOptions = {}): JsonClient {
  const fetchFn = options.fetchFn ?? fetch
  const { reasoningEffort, maxCompletionTokens } = options.requestOptions ?? {}
  let lastRoute: string | null = null
  return {
    async generateJson(prompt: string, schema: object): Promise<unknown> {
      const response = await fetchFn(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
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
  deps: { db: DbClient; logger: Logger } & Omit<GatewayClientOptions, 'onRoute'>,
): C {
  if (!config) return direct
  const gateway = createGatewayClient(config, {
    fetchFn: deps.fetchFn,
    requestOptions: deps.requestOptions,
    onRoute: (route) => deps.logger.info(`LLM gateway now served by ${route}`),
  })
  return {
    ...direct,
    async generateJson(prompt: string, schema: object): Promise<unknown> {
      const settings = await loadSettings(deps.db, [SETTING_KEY])
      if (settings[SETTING_KEY] !== 1) return direct.generateJson(prompt, schema)
      try {
        return await gateway.generateJson(prompt, schema)
      } catch (err) {
        deps.logger.warn(`LLM gateway failed (${summarizeError(err)}), falling back to direct client`)
        return direct.generateJson(prompt, schema)
      }
    },
  }
}
