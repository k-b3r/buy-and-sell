import { buildExtractionPrompt, EXTRACTION_RESPONSE_SCHEMA, parseExtractionItem } from './extraction'
import type { ExtractedListing } from './extraction'
import { PRODUCT_CATEGORIES, SUB_CATEGORIES } from './products'
import type { ExtractionCandidate } from '../types'

const listing: ExtractionCandidate = {
  id: 'l1',
  title: 'PS5 for sale',
  description: null,
  condition: null,
  price_amount: null,
}

function extracted(item: unknown): ExtractedListing {
  const outcome = parseExtractionItem(item, [listing])
  if (outcome.kind !== 'extracted') throw new Error(`expected an extracted item, got ${outcome.kind}`)
  return outcome.listing
}

test('parseExtractionItem canonicalizes a known alias and keys the product by normalized base model and variant', () => {
  const parsed = extracted({
    id: 'l1',
    base_model: 'PS5',
    variant: 'Digital',
    category: 'Other',
    sub_category: 'Nonsense',
  })
  expect(parsed).toEqual({
    candidate: listing,
    baseModel: 'PlayStation 5',
    variant: 'Digital',
    category: 'Other',
    subCategory: null,
    productKey: expect.stringMatching(/::.+$/),
  })
})

test('parseExtractionItem gives the same product key to an alias and its canonical form', () => {
  const alias = extracted({ id: 'l1', base_model: 'PS5' })
  const canonical = extracted({ id: 'l1', base_model: 'PlayStation 5' })
  expect(alias.productKey).toBe(canonical.productKey)
})

test('parseExtractionItem treats a blank variant as no variant', () => {
  expect(extracted({ id: 'l1', base_model: 'RTX 3060', variant: '  ' })).toMatchObject({
    variant: null,
    productKey: expect.stringMatching(/::$/),
  })
})

test('parseExtractionItem reports an item without a string id or base_model as malformed, with its id when valid', () => {
  expect(parseExtractionItem({ id: 1, base_model: 'RTX 3060' }, [listing])).toEqual({
    kind: 'malformed',
    idHint: '(missing/invalid id)',
  })
  expect(parseExtractionItem({ id: 'l1' }, [listing])).toEqual({ kind: 'malformed', idHint: 'l1' })
})

test('parseExtractionItem reports a null or non-object item as malformed instead of throwing', () => {
  expect(parseExtractionItem(null, [listing])).toEqual({ kind: 'malformed', idHint: '(missing/invalid id)' })
  expect(parseExtractionItem('l1', [listing])).toEqual({ kind: 'malformed', idHint: '(missing/invalid id)' })
})

test('parseExtractionItem reports an id that matches no listing in the batch', () => {
  expect(parseExtractionItem({ id: 'other', base_model: 'RTX 3060' }, [listing])).toEqual({
    kind: 'unknown-candidate',
    id: 'other',
  })
})

test('parseExtractionItem applies a variant alias rule so the alias lands on the canonical product', () => {
  const parsed = extracted({ id: 'l1', base_model: 'Samsung Galaxy A54', variant: '5G' })

  expect(parsed.baseModel).toBe('Samsung Galaxy A54')
  expect(parsed.variant).toBeNull()
  expect(parsed.productKey).toBe(extracted({ id: 'l1', base_model: 'Samsung Galaxy A54' }).productKey)
})

test('parseExtractionItem matches alias rules on normalized text, ignoring case and spacing', () => {
  const parsed = extracted({ id: 'l1', base_model: '  samsung galaxy   a54 ', variant: ' 5g ' })

  expect(parsed.baseModel).toBe('Samsung Galaxy A54')
  expect(parsed.variant).toBeNull()
})

test('parseExtractionItem renames the base model and the variant together when a rule changes both', () => {
  const parsed = extracted({ id: 'l1', base_model: 'PS4 Slim' })

  expect(parsed.baseModel).toBe('PlayStation 4')
  expect(parsed.variant).toBe('Slim')
})

test('parseExtractionItem leaves a name no rule covers untouched', () => {
  const parsed = extracted({ id: 'l1', base_model: 'Sony WH-1000XM4', variant: 'Black' })

  expect(parsed.baseModel).toBe('Sony WH-1000XM4')
  expect(parsed.variant).toBe('Black')
})

test('buildExtractionPrompt includes each listing id and title, and truncates long descriptions to 150 chars', () => {
  const longDesc =
    'Barely used, 2020 model, comes with charger and original box, no issues at all whatsoever really, works perfectly fine no scratches or dents anywhere on the case'
  const prompt = buildExtractionPrompt([
    { id: '1', title: 'Rush sale MacBook Air', description: longDesc },
    { id: '2', title: 'For sale rush', description: 'Sony WH-1000XM4 headphones' },
  ])

  expect(prompt).toContain('[id: 1] title: "Rush sale MacBook Air"')
  expect(prompt).toContain('[id: 2] title: "For sale rush"')
  expect(prompt).toContain('Sony WH-1000XM4 headphones')
  expect(prompt).not.toContain('no scratches or dents anywhere on the case')
})

// Root must be 'object' (a {results: [...]} envelope), not 'array' - Groq
// hard-rejects an array-rooted response_format schema regardless of model
// (confirmed live 2026-09-03). variant is nullable rather than omitted from
// `required`, since strict mode requires every property be listed there.
test('EXTRACTION_RESPONSE_SCHEMA is a {results: [...]} schema requiring id, base_model, category, and sub_category, with variant nullable', () => {
  expect(EXTRACTION_RESPONSE_SCHEMA.type).toBe('object')
  expect(EXTRACTION_RESPONSE_SCHEMA.required).toEqual(['results'])
  const items = EXTRACTION_RESPONSE_SCHEMA.properties.results.items
  expect(items.required).toEqual(['id', 'base_model', 'variant', 'category', 'sub_category'])
  expect(items.properties.variant.type).toEqual(['string', 'null'])
})

// Fixed, bounded list - freeform categorization would recreate the exact
// base_model fragmentation problem this session spent a lot of effort
// cleaning up, just one level higher (see CONTEXT.md's duplicate-product
// consolidation finding).
test('EXTRACTION_RESPONSE_SCHEMA constrains category to the fixed PRODUCT_CATEGORIES enum', () => {
  const items = EXTRACTION_RESPONSE_SCHEMA.properties.results.items
  expect(items.properties.category.enum).toEqual(PRODUCT_CATEGORIES)
  expect(items.required).toContain('category')
})

test('EXTRACTION_RESPONSE_SCHEMA constrains sub_category to the fixed SUB_CATEGORIES enum', () => {
  const items = EXTRACTION_RESPONSE_SCHEMA.properties.results.items
  expect(items.properties.sub_category.enum).toEqual(SUB_CATEGORIES)
  expect(items.required).toContain('sub_category')
})

// A 2026-09-02 catalog scan found the model's #1 cause of duplicate products
// was inconsistently leaving a trim/tier suffix in base_model instead of
// moving it to variant (e.g. "iPhone 14 Plus" [] vs "iPhone 14" [Plus] -
// same real product, two rows). Worked examples across the families that
// fragmented most, plus an explicit rule, are the fix - see
// variant-alias-rules.ts for the cleanup
// this was already needed for once.
test('buildExtractionPrompt tells the model to split a known trim/tier suffix out of base_model into variant, with worked examples', () => {
  const prompt = buildExtractionPrompt([{ id: '1', title: 'iPhone 14 Plus', description: '' }])

  expect(prompt).toContain('base_model: "iPhone 14", variant: "Plus"')
  expect(prompt).toContain('base_model: "iPad", variant: "9th Gen"')
  expect(prompt).toContain('base_model: "MacBook Air", variant: "M2"')
  expect(prompt).toContain('base_model: "Samsung Galaxy S23", variant: "Ultra"')
})

// Bare "5G"/"4G" as a variant was the #2 cause - noise on models sold in
// only one radio band (doubles the row for no reason), but load-bearing on
// models genuinely sold in both. Blanket-stripping it would just move the
// fragmentation problem, not fix it.
test('buildExtractionPrompt tells the model to only record a network band as variant when the same model is sold in more than one band', () => {
  const prompt = buildExtractionPrompt([{ id: '1', title: 'Samsung Galaxy A54 5G', description: '' }])

  expect(prompt).toMatch(/5G.*only.*sold in (more than one|both)|only record.*network band.*variant/is)
})

test('buildExtractionPrompt lists the fixed categories for the model to choose from', () => {
  const prompt = buildExtractionPrompt([{ id: '1', title: 'RTX 3060 OC Asus', description: '' }])
  for (const category of PRODUCT_CATEGORIES) {
    expect(prompt).toContain(category)
  }
})

test('buildExtractionPrompt lists the fixed sub-categories for the model to choose from', () => {
  const prompt = buildExtractionPrompt([{ id: '1', title: 'RTX 3060 OC Asus', description: '' }])
  for (const subCategory of SUB_CATEGORIES) {
    expect(prompt).toContain(subCategory)
  }
})

test('buildExtractionPrompt instructs the model to leave variant empty unless clearly signaled', () => {
  const prompt = buildExtractionPrompt([{ id: '1', title: 'RTX 3060 OC Asus', description: '' }])
  expect(prompt.toLowerCase()).toContain('variant')
})
