export type DelayFn = (ms: number) => Promise<void>

// The one real sleep (ESLint bans setTimeout elsewhere); everything else takes
// a DelayFn so tests can pass a no-op.
export const realDelay: DelayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
