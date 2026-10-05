import { REDACTED, redact, secretsFromEnv } from './redact'

describe('redact', () => {
  test('leaves a message without secrets byte-identical', () => {
    const msg = 'lap 3 complete, sleeping 60000ms — 12 listings (key=value pairs in prose stay)'
    expect(redact(msg, [])).toBe(msg)
  })

  test.each([
    ['key', 'https://generativelanguage.googleapis.com/v1/models/x:generate?key=AIzaSyA1b2C3', 'key'],
    ['api_key', 'GET /search?q=phone&api_key=abc123def', 'api_key'],
    ['apikey', 'GET /search?apikey=abc123def&q=phone', 'apikey'],
    ['token', 'https://x.test/cb?token=tok_9f8e7d', 'token'],
    ['access_token', 'https://graph.test/me?fields=id&access_token=EAAB12345', 'access_token'],
  ])('masks the value of a %s query param', (_name, msg, param) => {
    const out = redact(msg, [])
    expect(out).toContain(`${param}=${REDACTED}`)
    expect(out).not.toMatch(/AIzaSyA1b2C3|abc123def|tok_9f8e7d|EAAB12345/)
  })

  test('keeps the rest of a URL around a masked query param', () => {
    expect(redact('fetch failed: https://api.test/v1?key=secret123&q=iphone#top', [])).toBe(
      `fetch failed: https://api.test/v1?key=${REDACTED}&q=iphone#top`,
    )
  })

  test('masks credentials in a URL, keeping scheme and host', () => {
    expect(redact('proxy http://user-123:s3cretPass@p.webshare.io:80 unreachable', [])).toBe(
      `proxy http://${REDACTED}@p.webshare.io:80 unreachable`,
    )
    expect(redact('connect postgres://app:hunter22@db.local:5432/app failed', [])).toBe(
      `connect postgres://${REDACTED}@db.local:5432/app failed`,
    )
  })

  test('masks a Bearer token, alone or in an Authorization header', () => {
    expect(redact('401: Authorization: Bearer gsk_abcDEF123.456-xyz', [])).toBe(
      `401: Authorization: Bearer ${REDACTED}`,
    )
    expect(redact('sent bearer eyJhbGciOi.payload.sig= to exa', [])).toBe(`sent bearer ${REDACTED} to exa`)
  })

  test('leaves prose that uses the word bearer unmasked', () => {
    const msg = 'seller was the bearer of bad news; Bearer responsibilities apply to the bearer instrument'
    expect(redact(msg, [])).toBe(msg)
  })

  test('masks even a short Bearer token inside an Authorization header', () => {
    expect(redact('Authorization: Bearer abc123', [])).toBe(`Authorization: Bearer ${REDACTED}`)
  })

  test('masks every occurrence of a known secret value anywhere in the message', () => {
    const secret = 'fake-groq-key-for-tests'
    expect(redact(`Groq 401 for key ${secret} (key ${secret})`, [secret])).toBe(
      `Groq 401 for key ${REDACTED} (key ${REDACTED})`,
    )
  })

  test('masks the longer of two overlapping known secrets whole', () => {
    expect(redact('k=abcdefgh123456', ['abcdefgh', 'abcdefgh123456'])).toBe(`k=${REDACTED}`)
  })

  test('ignores empty and very short known secrets so ordinary words are never masked', () => {
    expect(redact('lap 1 starting', ['', '1', 'lap'])).toBe('lap 1 starting')
  })
})

describe('secretsFromEnv', () => {
  test('collects values of env vars whose names mark them as secrets', () => {
    const secrets = secretsFromEnv({
      GROQ_API_KEY0: 'gsk_aaaaaaaa',
      EXA_API_KEY1: 'exa_bbbbbbbb',
      FREE_GEMINI_API_KEY: 'AIzaCCCCCCCC',
      REFRESH_API_KEY: 'refresh-dddddddd',
      R2_ACCESS_KEY_ID: 'r2accessEEEEEEEE',
      R2_SECRET_KEY: 'r2secretFFFFFFFF',
      R2_TOKEN_VALUE: 'r2tokenGGGGGGGG',
      R2_BUCKET_NAME: 'listing-photos',
      SERVER_PORT: '8787',
    })
    expect(secrets).toEqual(
      expect.arrayContaining([
        'gsk_aaaaaaaa',
        'exa_bbbbbbbb',
        'AIzaCCCCCCCC',
        'refresh-dddddddd',
        'r2accessEEEEEEEE',
        'r2secretFFFFFFFF',
        'r2tokenGGGGGGGG',
      ]),
    )
    expect(secrets).not.toContain('listing-photos')
    expect(secrets).not.toContain('8787')
  })

  test('ignores secret-looking names that hold a path or URL, not a secret (KEY_PATH, TOKEN_URL)', () => {
    const secrets = secretsFromEnv({
      KEY_PATH: '/etc/ssl/private/server.pem',
      SSH_KEY_FILE: '/home/app/.ssh/id_ed25519',
      TOKEN_URL: 'https://oauth.example.test/token',
      SECRET_DIR: '/run/secrets/app',
    })
    expect(secrets).toEqual([])
  })

  test('collects passwords embedded in URL-valued env vars (DATABASE_URL, proxies), raw and decoded', () => {
    const secrets = secretsFromEnv({
      DATABASE_URL: 'postgres://app:p%40ssw0rd99@db.local:5432/app',
      WEBSHARE_PROXY: 'http://user-1:proxyPass77@p.webshare.io:80',
      SOCKS_PROXY: 'socks5://127.0.0.1:1080',
    })
    expect(secrets).toEqual(expect.arrayContaining(['p%40ssw0rd99', 'p@ssw0rd99', 'proxyPass77']))
    expect(secrets).not.toContain('app')
  })
})
