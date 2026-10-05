export type { GeminiClient } from './gemini'
export {
  createGeminiClient,
  createFallbackGeminiClient,
  createDailyGroundingCap,
  createQuotaAwareGeminiClient,
} from './gemini'

export type { ExaClient } from './exa'
export { createExaClient, createFallbackExaClient, loadExaApiKeys } from './exa'

export type { GroqClient, GroqRequestOptions } from './groq'
export {
  createGroqClient,
  createFallbackGroqClient,
  createModelFallbackGroqClient,
  createRoundRobinGroqClient,
  createGroqPool,
  loadGroqApiKeys,
  GROQ_MODEL_FALLBACK_CHAIN,
} from './groq'
export { summarizeError as summarizeGroqError } from '../../platform/errors'

export type { TavilyClient, TavilySearchResult } from './tavily'
export { createTavilyClient } from './tavily'

export type { OpenRouterClient } from './openrouter'
export { createOpenRouterClient, createFallbackOpenRouterClient } from './openrouter'

export { QuotaExhaustedError, isQuotaError, isCreditsError } from './error-classification'
export type { RetryOptions } from './retry'
export { RetriesExhaustedError, withRetry, withRetryAndSplit } from './retry'
