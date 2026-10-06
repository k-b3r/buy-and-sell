// The only file that loads groq-sdk (depcruise heavy-dep owner): workers that
// build a real Groq client import this file by path, so code that only needs
// the GroqClient type or the pool helpers never loads the SDK.
import Groq from 'groq-sdk'
import type { GroqClient, GroqRequestOptions } from './groq'
import {
  buildGroqRequest,
  createFallbackGroqClient,
  createRoundRobinGroqClient,
  GROQ_MODEL_FALLBACK_CHAIN,
} from './groq'

function createGroqClient(apiKey: string, model = 'openai/gpt-oss-120b', options: GroqRequestOptions = {}): GroqClient {
  const client = new Groq({ apiKey })
  return {
    async generateJson(prompt: string, schema: object): Promise<unknown> {
      const response = await client.chat.completions.create(buildGroqRequest(model, prompt, schema, options))
      const content = response.choices[0]?.message?.content
      if (!content) {
        throw new Error('Groq response contained no content')
      }
      return JSON.parse(content)
    },
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
  requestOptions: GroqRequestOptions = {},
): GroqClient {
  const keyLabels = apiKeys.map((_, i) => `GROQ_API_KEY${i}`)
  const perKeyClients = apiKeys.map((apiKey, i) =>
    createFallbackGroqClient(
      models.map((model) => createGroqClient(apiKey, model, requestOptions)),
      {
        labels: [...models],
        onFallback: (fromModel, toModel) => onFallback?.(`${keyLabels[i]}:${fromModel}`, `${keyLabels[i]}:${toModel}`),
      },
    ),
  )
  return createRoundRobinGroqClient(perKeyClients, { labels: keyLabels, onFallback })
}
