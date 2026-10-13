import { loadServerConfig } from './config'

const R2_ENV = {
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_KEY: 'secret',
  R2_BUCKET_NAME: 'bucket',
  R2_PUBLIC_BASE_URL: 'https://photos.example.test',
}

const FULL_ENV = { REFRESH_API_KEY: 'k', DATABASE_URL: 'postgres://db', ...R2_ENV }

test('loadServerConfig returns the key, database url and port when everything is set', () => {
  const config = loadServerConfig({ ...FULL_ENV, SERVER_PORT: '9000' })
  expect(config.apiKey).toBe('k')
  expect(config.dbUrl).toBe('postgres://db')
  expect(config.port).toBe(9000)
  expect(config.photoIo.store).toBeDefined()
})

test('loadServerConfig defaults the port to 8787', () => {
  expect(loadServerConfig(FULL_ENV).port).toBe(8787)
})

test('loadServerConfig throws naming REFRESH_API_KEY when it is missing', () => {
  expect(() => loadServerConfig({ ...FULL_ENV, REFRESH_API_KEY: undefined })).toThrow('REFRESH_API_KEY not set in .env')
})

test('loadServerConfig throws naming DATABASE_URL when it is missing', () => {
  expect(() => loadServerConfig({ ...FULL_ENV, DATABASE_URL: undefined })).toThrow('DATABASE_URL not set in .env')
})

test('loadServerConfig throws when R2 is only partly configured', () => {
  expect(() => loadServerConfig({ ...FULL_ENV, R2_BUCKET_NAME: undefined })).toThrow('R2 not fully configured in .env')
})
