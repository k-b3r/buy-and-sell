import Anthropic from '@anthropic-ai/sdk'

export interface AnthropicClient {
  searchStructured(query: string, systemPrompt: string, schema: object): Promise<unknown>
}

const MODEL = 'claude-haiku-4-5'
// Haiku 4.5 is not in the model list for the dynamic-filtering web_search
// tool (web_search_20260209 requires Opus 5/4.8/4.7/4.6, Sonnet 5, or
// Sonnet 4.6) - use the basic variant instead. No beta header either way.
const WEB_SEARCH_TOOL_TYPE = 'web_search_20250305'
const MAX_WEB_SEARCHES_PER_CALL = 4
const MAX_TOKENS = 1536

export function createAnthropicClient(apiKey: string): AnthropicClient {
  const client = new Anthropic({ apiKey })
  return {
    async searchStructured(query: string, systemPrompt: string, schema: object): Promise<unknown> {
      const messages: Anthropic.MessageParam[] = [{ role: 'user', content: query }]
      const baseParams = {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', max_uses: MAX_WEB_SEARCHES_PER_CALL }],
        output_config: { format: { type: 'json_schema', schema } },
      }

      let response: Anthropic.Message = await (client.messages.create as (params: unknown) => Promise<Anthropic.Message>)({
        ...baseParams,
        messages,
      })

      // A server-tool turn (web_search) can hit the default 10-iteration
      // cap and pause mid-search rather than finish - resend the paused
      // turn so the API resumes the same server-side loop instead of the
      // caller silently getting an incomplete answer. Do NOT add an extra
      // "Continue." user message - the API detects the trailing
      // server_tool_use block and resumes automatically from the appended
      // assistant turn.
      while (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content as unknown as Anthropic.MessageParam['content'] })
        response = await (client.messages.create as (params: unknown) => Promise<Anthropic.Message>)({ ...baseParams, messages })
      }

      return response
    },
  }
}

export function isAnthropicRateLimitError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'status' in err && (err as { status?: unknown }).status === 429
}

// Same permanent-switch-on-exhaustion pattern as createFallbackGeminiClient/
// createFallbackExaClient - once a key's rate limit is hit, there's no
// reason to try it again this run. Any other error is rethrown immediately
// without switching.
export function createFallbackAnthropicClient(clients: AnthropicClient[]): AnthropicClient {
  let currentIndex = 0

  async function withFallback<T>(call: (client: AnthropicClient) => Promise<T>): Promise<T> {
    while (currentIndex < clients.length) {
      try {
        return await call(clients[currentIndex])
      } catch (err) {
        if (isAnthropicRateLimitError(err) && currentIndex < clients.length - 1) {
          currentIndex += 1
          continue
        }
        throw err
      }
    }
    throw new Error('all Anthropic clients exhausted')
  }

  return {
    searchStructured: (query, systemPrompt, schema) => withFallback((client) => client.searchStructured(query, systemPrompt, schema)),
  }
}
