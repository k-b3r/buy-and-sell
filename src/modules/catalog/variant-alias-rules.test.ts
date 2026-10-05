import { normalizeBaseModel, normalizeVariantTier } from './products'
import { PRODUCT_VARIANT_ALIAS_RULES } from './variant-alias-rules'

function key(base: string, variant: string | null): string {
  return `${normalizeBaseModel(base)}::${variant === null ? '' : normalizeVariantTier(variant)}`
}

test('every variant alias rule changes the product identity it matches', () => {
  const noOps = PRODUCT_VARIANT_ALIAS_RULES.filter(
    (r) => key(r.aliasBase, r.aliasVariant) === key(r.canonicalBase, r.canonicalVariant),
  )
  expect(noOps).toEqual([])
})

test('no two variant alias rules match the same alias product', () => {
  const keys = PRODUCT_VARIANT_ALIAS_RULES.map((r) => key(r.aliasBase, r.aliasVariant))
  expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([])
})
