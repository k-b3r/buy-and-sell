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

export function isQuotaError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'status' in err && (err as { status?: unknown }).status === 429
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
