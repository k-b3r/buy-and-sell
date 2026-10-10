import { PRODUCT_VARIANT_ALIAS_RULES } from './variant-alias-rules'
import { normalizeBaseModel, normalizeVariantTier } from './products'

test('every alias rule has a distinct alias key, so none silently shadows another at extraction', () => {
  const keys = PRODUCT_VARIANT_ALIAS_RULES.map(
    (r) => `${normalizeBaseModel(r.aliasBase)}::${r.aliasVariant ? normalizeVariantTier(r.aliasVariant) : ''}`,
  )
  const duplicates = keys.filter((key, i) => keys.indexOf(key) !== i)

  expect(duplicates).toEqual([])
})
