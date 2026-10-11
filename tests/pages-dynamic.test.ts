import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

// Dashboard rule (CODING_STANDARDS.md): a page that reads data from the VPS must
// not be prerendered at build time, or it freezes today's data until the next deploy.
const APP_DIR = new URL('../dashboard/src/app/', import.meta.url).pathname

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? pageFiles(join(dir, entry.name)) : entry.name === 'page.tsx' ? [join(dir, entry.name)] : [],
  )
}

const dataPages = pageFiles(APP_DIR).filter((file) =>
  /from '@\/lib\/(queries|cachedQueries)'/.test(readFileSync(file, 'utf8')),
)

test('the dashboard has data pages to check', () => {
  expect(dataPages.length).toBeGreaterThan(0)
})

test.each(dataPages.map((file) => file.replace(APP_DIR, 'app/')))(
  'data page %s exports dynamic = force-dynamic',
  (page) => {
    const text = readFileSync(join(APP_DIR, page.replace('app/', '')), 'utf8')
    expect(text).toMatch(/export const dynamic = 'force-dynamic'/)
  },
)
