export interface RateLimiter {
  isBlocked(ip: string): boolean
  recordFailure(ip: string): void
  recordSuccess(ip: string): void
}

// Fixed-window failed-auth throttle, keyed by client IP - every route on
// this server shares one bearer token (see app.ts), so an unlimited-attempt
// brute force against that token is the actual threat, not per-route abuse.
// In-memory/single-process is fine here: this runs as one long-lived Node
// process on one box, no need for Redis/distributed state for a personal
// tool with this little traffic.
export function createRateLimiter(maxFailures: number, windowMs: number, now: () => number = Date.now): RateLimiter {
  const failuresByIp = new Map<string, number[]>()

  function recentFailures(ip: string): number[] {
    const cutoff = now() - windowMs
    const pruned = (failuresByIp.get(ip) ?? []).filter((t) => t > cutoff)
    failuresByIp.set(ip, pruned)
    return pruned
  }

  return {
    isBlocked(ip) {
      return recentFailures(ip).length >= maxFailures
    },
    recordFailure(ip) {
      const timestamps = recentFailures(ip)
      timestamps.push(now())
      failuresByIp.set(ip, timestamps)
    },
    // A correct token clears the slate - the window only exists to blunt
    // guessing, not to punish an IP that's already proven it knows the key.
    recordSuccess(ip) {
      failuresByIp.delete(ip)
    },
  }
}
