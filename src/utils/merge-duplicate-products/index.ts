import { fileURLToPath } from 'node:url'
import { createDbPool } from '../../platform/storage'
import { loadEnvFile } from '../../platform/env'
import { mergeDuplicateProducts, mergeProductVariantAliases, PRODUCT_VARIANT_ALIAS_RULES } from '../../modules/catalog'

async function main() {
  loadEnvFile()
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL not set in .env')
  const dryRun = process.argv.includes('--dry-run')

  const pool = createDbPool(dbUrl)
  try {
    const { renamed, merged } = await mergeDuplicateProducts(pool, { dryRun })
    console.log(
      `[base-model map]${dryRun ? ' (dry run)' : ''} renamed ${renamed} products, merged ${merged} duplicate rows`,
    )

    const variantResult = await mergeProductVariantAliases(pool, PRODUCT_VARIANT_ALIAS_RULES, { dryRun })
    console.log(
      `[variant-alias rules]${dryRun ? ' (dry run)' : ''} renamed ${variantResult.renamed} products, merged ${variantResult.merged} duplicate rows`,
    )
    if (variantResult.noMatch.length > 0) {
      console.log(
        `${variantResult.noMatch.length} rule(s) matched nothing live (already applied, or a transcription mismatch):`,
      )
      for (const rule of variantResult.noMatch) {
        console.log(
          `  ${rule.aliasBase} [${rule.aliasVariant ?? ''}] -> ${rule.canonicalBase} [${rule.canonicalVariant ?? ''}]`,
        )
      }
    }
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
