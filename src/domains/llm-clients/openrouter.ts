export interface OpenRouterClient {
  generateJson(prompt: string, schema: object): Promise<unknown>
}

export function createOpenRouterClient(apiKey: string, model = 'deepseek/deepseek-v4-flash-0731'): OpenRouterClient {
  return {
    async generateJson(prompt: string, schema: object): Promise<unknown> {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'response', strict: true, schema },
          },
        }),
      })
      if (!response.ok) {
        const body = await response.text()
        const err = new Error(`OpenRouter request failed: ${response.status} ${body}`) as Error & { status: number }
        err.status = response.status
        throw err
      }
      const data = (await response.json()) as { choices: { message: { content: string } }[] }
      const content = data.choices[0]?.message?.content
      if (!content) {
        throw new Error('OpenRouter response contained no content')
      }
      return JSON.parse(content)
    },
  }
}

// 429 is OpenRouter's rate-limit signal; 402 is its insufficient-credits
// signal (same convention as Exa's isExaCreditsError) - both mean "this key
// is done for now," not a real failure worth retrying against the same key.
export function isQuotaError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('status' in err)) return false
  const status = (err as { status?: unknown }).status
  return status === 429 || status === 402
}

// Same permanent-switch-on-exhaustion pattern as createFallbackGroqClient/
// createFallbackGeminiClient - once a key's quota/credits are known to be
// gone, there's no reason to try it again this run. Any other error
// (malformed response, network failure) is not a quota signal and is
// rethrown immediately without switching.
export function createFallbackOpenRouterClient(clients: OpenRouterClient[]): OpenRouterClient {
  let currentIndex = 0

  async function withFallback<T>(call: (client: OpenRouterClient) => Promise<T>): Promise<T> {
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
    throw new Error('all OpenRouter clients exhausted')
  }

  return {
    generateJson: (prompt, schema) => withFallback((client) => client.generateJson(prompt, schema)),
  }
}
