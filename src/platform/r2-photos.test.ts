import { r2PhotoIoFromEnv } from './r2-photos'
import { defaultCompressImage, defaultFetchBytes, type ImageStore, type R2Config } from './images'

const FULL_ENV = {
  R2_ACCOUNT_ID: 'test-account',
  R2_ACCESS_KEY_ID: 'test-key-id',
  R2_SECRET_KEY: 'test-secret',
  R2_BUCKET_NAME: 'test-bucket',
  R2_PUBLIC_BASE_URL: 'https://photos.example.test',
}

const fakeStore: ImageStore = {
  put: async () => '',
  deleteAll: async () => {},
  list: async () => [],
  delete: async () => {},
}

test('r2PhotoIoFromEnv builds the R2 store from the five R2 env vars and pairs it with the default fetch and compress', () => {
  const configs: R2Config[] = []
  const io = r2PhotoIoFromEnv(FULL_ENV, (config) => {
    configs.push(config)
    return fakeStore
  })

  expect(configs).toEqual([
    {
      accountId: 'test-account',
      accessKeyId: 'test-key-id',
      secretAccessKey: 'test-secret',
      bucket: 'test-bucket',
      publicBaseUrl: 'https://photos.example.test',
    },
  ])
  expect(io).toEqual({ store: fakeStore, fetchBytes: defaultFetchBytes, compress: defaultCompressImage })
})

test.each(Object.keys(FULL_ENV))('r2PhotoIoFromEnv returns null when %s is missing', (key) => {
  const env: Record<string, string | undefined> = { ...FULL_ENV, [key]: '' }
  expect(r2PhotoIoFromEnv(env, () => fakeStore)).toBeNull()
})
