// Public API of the LLM clients: client types, fallback/round-robin pools,
// retry and error classification. The SDK-backed constructors are absent on
// purpose: gemini-sdk.ts and groq-sdk.ts own @google/genai and groq-sdk and are
// imported by path only where a worker builds a real client.
export type { GeminiClient } from './gemini'
export { createFallbackGeminiClient, createDailyGroundingCap, createQuotaAwareGeminiClient } from './gemini'

export type { ExaClient } from './exa'
export { createExaClient, createFallbackExaClient, loadExaApiKeys } from './exa'

export type { GroqClient, GroqRequestOptions } from './groq'
export {
  createFallbackGroqClient,
  createRoundRobinGroqClient,
  loadGroqApiKeys,
  GROQ_MODEL_FALLBACK_CHAIN,
} from './groq'
export { summarizeError as summarizeGroqError } from '../errors'

export type { TavilyClient, TavilySearchResult } from './tavily'
export { createTavilyClient } from './tavily'

export type { OpenRouterClient } from './openrouter'
export { createOpenRouterClient, createFallbackOpenRouterClient } from './openrouter'

export type { GatewayConfig } from './gateway'
export { createGatewayClient, loadGatewayConfig, withGateway } from './gateway'

export { QuotaExhaustedError, isQuotaError, isCreditsError } from './error-classification'
export type { RetryOptions } from './retry'
export { RetriesExhaustedError, withRetry, withRetryAndSplit } from './retry'
