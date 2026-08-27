import Groq from 'groq-sdk'

export interface GroqClient {
  generateJson(prompt: string, schema: object): Promise<unknown>
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

export function isQuotaError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'status' in err && (err as { status?: unknown }).status === 429
}

// Wraps multiple GroqClients (e.g. different models on the same key — Groq's
// daily token cap is scoped per-model, confirmed live 2026-08-22 via the real
// 429 body naming the specific model — so a different model has its own,
// untouched quota) and falls back to the next one the moment the current one
// hits a quota error (HTTP 429). The switch is permanent for the rest of the
// process. Any other kind of error (the occasional structural glitch, network
// failure, etc.) is not a quota signal and is rethrown immediately without
// switching — runProductEnrichment's own retry loop handles those.
export function createFallbackGroqClient(clients: GroqClient[]): GroqClient {
  let currentIndex = 0

  async function withFallback<T>(call: (client: GroqClient) => Promise<T>): Promise<T> {
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
    throw new Error('all Groq clients exhausted')
  }

  return {
    generateJson: (prompt, schema) => withFallback((client) => client.generateJson(prompt, schema)),
  }
}
