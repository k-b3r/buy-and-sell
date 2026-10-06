// Masks secrets out of a log message before the logger writes it anywhere
// (console, data/*.log, and from there the dashboard's logs view). Callers
// interpolate raw provider errors, proxy details and URLs, so redaction
// lives here, once, instead of at each call site.

export const REDACTED = '[REDACTED]'

// Shorter known secrets are skipped: masking every "1" or "app" would wreck
// ordinary log lines, and no real key or password in .env is this short.
const MIN_SECRET_LENGTH = 8

const SECRET_QUERY_PARAMS = [
  'key',
  'api_key',
  'apikey',
  'api-key',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'secret',
  'password',
  'signature',
  'x-amz-signature',
  'x-amz-credential',
]

const QUERY_PARAM_RE = new RegExp(`([?&](?:${SECRET_QUERY_PARAMS.join('|')})=)[^&#\\s"'<>]+`, 'gi')
const URL_CREDENTIALS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@"'<>]+@/gi
// "Bearer" is also an English word ("bearer of bad news"), so outside an
// Authorization header only a token-like value is masked: at least
// MIN_BARE_BEARER_TOKEN_LENGTH chars with a digit or punctuation in it.
const MIN_BARE_BEARER_TOKEN_LENGTH = 16
const TOKEN_CHAR = '[A-Za-z0-9\\-._~+/]'
// Header shapes seen in logged errors: `Authorization: Bearer x`, JSON
// `"Authorization": "Bearer x"`, and `authorization=Bearer x`.
const AUTHORIZATION_BEARER_RE = new RegExp(`\\b(authorization["']?\\s*[:=]\\s*["']?bearer\\s+)${TOKEN_CHAR}+=*`, 'gi')
const BARE_BEARER_RE = new RegExp(
  `\\b(bearer\\s+)(?=${TOKEN_CHAR}*[0-9\\-._~+/])${TOKEN_CHAR}{${MIN_BARE_BEARER_TOKEN_LENGTH},}=*`,
  'gi',
)

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function redact(message: string, secrets: readonly string[]): string {
  let out = message
  const known = [...new Set(secrets)].filter((s) => s.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length)
  if (known.length > 0) {
    out = out.replace(new RegExp(known.map(escapeRegExp).join('|'), 'g'), REDACTED)
  }
  return out
    .replace(URL_CREDENTIALS_RE, `$1${REDACTED}@`)
    .replace(QUERY_PARAM_RE, `$1${REDACTED}`)
    .replace(AUTHORIZATION_BEARER_RE, `$1${REDACTED}`)
    .replace(BARE_BEARER_RE, `$1${REDACTED}`)
}

// Env var names that hold a secret by convention: GROQ_API_KEY0,
// R2_SECRET_KEY, R2_TOKEN_VALUE, REFRESH_API_KEY... Matching on the name means
// a key added to .env later is covered without touching any code.
const SECRET_NAME_RE = /(^|_)(KEY|TOKEN|SECRET|PASSWORD)\d*(_|$)/i
// ...except names that point at a secret rather than hold one (KEY_PATH,
// TOKEN_URL): masking a file path or endpoint would wreck ordinary log lines.
const LOCATOR_NAME_RE = /_(PATH|FILE|DIR|URL|URI|HOST|PORT)$/i

function urlPassword(value: string): string[] {
  if (!value.includes('://')) return []
  try {
    const { password } = new URL(value)
    if (!password) return []
    return [password, decodeURIComponent(password)]
  } catch {
    return []
  }
}

// The known-secret list a logger masks: secret-named env values plus the
// password inside any URL-valued var (DATABASE_URL, WEBSHARE_PROXY, ...).
export function secretsFromEnv(env: Record<string, string | undefined>): string[] {
  const secrets: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue
    if (SECRET_NAME_RE.test(name) && !LOCATOR_NAME_RE.test(name)) secrets.push(value)
    secrets.push(...urlPassword(value))
  }
  return [...new Set(secrets)]
}
