// Nightly Postgres backup to R2.
//
// Neon used to handle this. Since the database moved onto this VPS (see the
// migration off Neon), nothing else does - a lost disk means a lost dataset,
// and the scrape history is not reproducible.
//
// Runs from cron on the VPS as the scraper user. Dumps to /var/backups, keeps
// KEEP_LOCAL there for a fast restore, uploads to R2 under db-backups/ and
// prunes objects older than KEEP_REMOTE.

import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'

const BACKUP_DIR = process.env.BACKUP_DIR ?? '/var/backups/buy-and-sell'
const PREFIX = 'db-backups/'
// One of each: no scrape history is kept, the dumps only guard against a
// lost disk, and the VPS disk is small.
const KEEP_LOCAL = 1
const KEEP_REMOTE = 1

function loadEnv(file) {
  const out = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

const env = loadEnv(process.env.ENV_FILE ?? '.env')
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const name = `buyandsell-${stamp}.dump`

mkdirSync(BACKUP_DIR, { recursive: true })
const target = path.join(BACKUP_DIR, name)

// -Fc so a partial restore of a single table is possible without replaying
// the whole thing.
execFileSync('pg_dump', [env.DATABASE_URL, '-Fc', '--no-owner', '--no-acl', '-f', target], { stdio: 'pipe' })
const size = statSync(target).size
if (size < 1_000_000) throw new Error(`dump suspiciously small (${size} bytes) - refusing to rotate`)
console.log(`dumped ${name} (${(size / 1e6).toFixed(1)}MB)`)

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_KEY },
})

await client.send(
  new PutObjectCommand({
    Bucket: env.R2_BUCKET_NAME,
    Key: PREFIX + name,
    Body: readFileSync(target),
  }),
)
console.log(`uploaded ${PREFIX}${name}`)

// Local rotation: newest KEEP_LOCAL survive.
const local = readdirSync(BACKUP_DIR)
  .filter((f) => f.endsWith('.dump'))
  .sort()
  .reverse()
for (const stale of local.slice(KEEP_LOCAL)) {
  unlinkSync(path.join(BACKUP_DIR, stale))
  console.log(`pruned local ${stale}`)
}

// Remote rotation. Keys are timestamp-named, so lexical sort is chronological.
const listed = await client.send(new ListObjectsV2Command({ Bucket: env.R2_BUCKET_NAME, Prefix: PREFIX }))
const remote = (listed.Contents ?? [])
  .map((o) => o.Key)
  .sort()
  .reverse()
const expired = remote.slice(KEEP_REMOTE)
if (expired.length > 0) {
  await client.send(
    new DeleteObjectsCommand({
      Bucket: env.R2_BUCKET_NAME,
      Delete: { Objects: expired.map((Key) => ({ Key })) },
    }),
  )
  console.log(`pruned ${expired.length} remote`)
}
console.log(`done - ${Math.min(local.length, KEEP_LOCAL)} local, ${Math.min(remote.length, KEEP_REMOTE)} remote`)
