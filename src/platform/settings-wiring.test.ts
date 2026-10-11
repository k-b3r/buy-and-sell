import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { SETTING_DEFAULTS } from './settings'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

const schema = read('db/schema.sql')
const dashboardCatalog = [
  'dashboard/src/app/admin/settings/listingSettings.ts',
  'dashboard/src/app/admin/settings/workerSettings.ts',
]
  .map(read)
  .join('\n')

test.each(Object.keys(SETTING_DEFAULTS))('setting %s is seeded in db/schema.sql', (key) => {
  expect(schema).toContain(`'${key}'`)
})

test.each(Object.keys(SETTING_DEFAULTS))('setting %s has an entry in the dashboard settings catalog', (key) => {
  expect(dashboardCatalog).toContain(key)
})
