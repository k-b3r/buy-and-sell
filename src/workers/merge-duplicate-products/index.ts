import { fileURLToPath } from 'node:url'
import type { DbClient } from '../../storage/client'
import { createDbPool } from '../../storage/client'
import { loadEnvFile } from '../../utils'
import { mergeDuplicateProduct } from './storage'
import { normalizeBaseModel } from '../../products'

// Manually identified (2026-08-23) from a real scan of distinct base_model
// text — same real product, split into separate rows purely by inconsistent
// extraction text (abbreviation, spacing, "Galaxy" present or not). Every key
// here is an exact base_model string to retire in favor of its value.
export const CANONICAL_BASE_MODEL: Record<string, string> = {
  Airfryer: 'Air Fryer',
  Ebike: 'E-Bike',
  'GTX 1660Ti': 'GTX 1660 Ti',
  'Huawei MateBook D15': 'Huawei MateBook D 15',
  'Infinix GT30': 'Infinix GT 30',
  'JBL Party Box 320': 'JBL PartyBox 320',
  'Nvision Monitor': 'N-Vision Monitor',
  'RTX 3070ti': 'RTX 3070 Ti',
  'Samsung A07': 'Samsung Galaxy A07',
  'Samsung A16': 'Samsung Galaxy A16',
  'Samsung A36': 'Samsung Galaxy A36',
  'Samsung A54': 'Samsung Galaxy A54',
  'Samsung A55': 'Samsung Galaxy A55',
  'Samsung A57': 'Samsung Galaxy A57',
  'Samsung S21': 'Samsung Galaxy S21',
  'Samsung S22': 'Samsung Galaxy S22',
  'Samsung S23': 'Samsung Galaxy S23',
  'Samsung S24': 'Samsung Galaxy S24',
  'Samsung S25': 'Samsung Galaxy S25',
  'Samsung Galaxy S25 Series': 'Samsung Galaxy S25',
  'Samsung S26': 'Samsung Galaxy S26',
  'Samsung Galaxy Watch5': 'Samsung Galaxy Watch 5',
  'Samsung Galaxy Watch6': 'Samsung Galaxy Watch 6',
  'Samsung Z Flip 3': 'Samsung Galaxy Z Flip 3',
  'Samsung Z Flip 4': 'Samsung Galaxy Z Flip 4',
  'Samsung Z Flip 5': 'Samsung Galaxy Z Flip 5',
  'Samsung Galaxy Z Flip5': 'Samsung Galaxy Z Flip 5',
  'Samsung Galaxy Z Flip6': 'Samsung Galaxy Z Flip 6',
  'Samsung Z Flip 6': 'Samsung Galaxy Z Flip 6',
  'Samsung Z Flip6': 'Samsung Galaxy Z Flip 6',
  'Samsung Z Flip 7': 'Samsung Galaxy Z Flip 7',
  'Sony CH520': 'Sony CH-520',
  'Sony Wireless Headphones': 'Sony Headphones',
  'Sony WH1000XM5': 'Sony WH-1000XM5',
  'Tecno Mega Pad': 'Tecno MegaPad',
  PS4: 'PlayStation 4',
  PS5: 'PlayStation 5',
}

interface ProductRow {
  id: number
  variant_tier: string | null
}

// Renames in place when nothing collides. When the canonical name + same raw
// variant_tier already exists as a different row (the common case — that's
// WHY these were split), merges into it instead of renaming, since the
// products_base_model_variant_idx unique index would otherwise reject the
// rename outright.
export async function mergeDuplicateProducts(
  db: DbClient,
  canonicalMap: Record<string, string> = CANONICAL_BASE_MODEL,
): Promise<{ renamed: number; merged: number }> {
  let renamed = 0
  let merged = 0

  for (const [alias, canonical] of Object.entries(canonicalMap)) {
    const aliasRows = (await db.query(`SELECT id, variant_tier FROM products WHERE base_model = $1`, [alias])) as {
      rows: ProductRow[]
    }

    for (const row of aliasRows.rows) {
      const existing = (await db.query(
        `SELECT id FROM products WHERE base_model = $1 AND COALESCE(variant_tier, '') = COALESCE($2, '') AND id != $3`,
        [canonical, row.variant_tier, row.id],
      )) as { rows: { id: number }[] }

      if (existing.rows.length > 0) {
        await mergeDuplicateProduct(db, existing.rows[0].id, row.id)
        merged++
      } else {
        await db.query(`UPDATE products SET base_model = $1, base_model_normalized = $2 WHERE id = $3`, [
          canonical,
          normalizeBaseModel(canonical),
          row.id,
        ])
        renamed++
      }
    }
  }

  return { renamed, merged }
}

async function main() {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env')

  const pool = createDbPool(dbUrl)
  try {
    const { renamed, merged } = await mergeDuplicateProducts(pool)
    console.log(`renamed ${renamed} products, merged ${merged} duplicate rows`)
  } finally {
    await pool.end()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
