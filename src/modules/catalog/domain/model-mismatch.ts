// Catches the failure mode found manually in listing 1000000000000002
// ("Samsung S23 ULTRA..." matched to product "Samsung Galaxy S26 Ultra"):
// title and matched product name disagree about a model's generation
// number even though they share the same product line prefix (e.g. "S").
// Digit-before-letter specs (128GB, 5G, 4K, 2024) are naturally excluded
// since both patterns below require the letters to come first.
const NOISE_PREFIXES = new Set([
  'gb',
  'tb',
  'mb',
  'kb',
  'ram',
  'rom',
  'rm',
  'mp',
  'mah',
  'hz',
  'khz',
  'mhz',
  'cm',
  'mm',
  'km',
  'kg',
  'hr',
  'hrs',
  'min',
  'mins',
  'sec',
  'secs',
  'pc',
  'pcs',
  'php',
  'peso',
  'pesos',
  'p',
  'no',
  'unit',
  'units',
  'day',
  'days',
  'month',
  'months',
  'year',
  'years',
  'yr',
  'yrs',
  'floor',
  'flr',
  'lot',
  'block',
  'blk',
  'room',
  'sqm',
  'sq',
  'sqft',
  'sf',
  'qty',
  'pack',
  'set',
  'sets',
  'pax',
  'person',
  'persons',
  'w',
  'v',
  'inch',
  'inches',
  'in',
  'ft',
  'vol',
  'ep',
  'season',
  'page',
  'pg',
  'step',
  'level',
  'lvl',
])

const TIGHT_CODE = /\b([A-Za-z]{1,3})(\d{2,3})\b/g
const LOOSE_CODE = /\b([A-Za-z]{2,12})\s+(\d{1,3})\b/g

// prefix (lowercased) -> set of model numbers seen for that prefix
function extractModelCodes(text: string): Map<string, Set<string>> {
  const codes = new Map<string, Set<string>>()
  for (const regex of [TIGHT_CODE, LOOSE_CODE]) {
    for (const match of text.matchAll(regex)) {
      const prefix = match[1].toLowerCase()
      if (NOISE_PREFIXES.has(prefix)) continue
      const numbers = codes.get(prefix) ?? new Set<string>()
      numbers.add(match[2])
      codes.set(prefix, numbers)
    }
  }
  return codes
}

export interface ModelCodeMismatch {
  prefix: string
  titleNumbers: string[]
  productNumbers: string[]
}

// Flags prefixes the title and the matched product's name both use, but
// with disjoint model numbers - a strong signal the listing was matched to
// the wrong product line generation, not just a variant/storage difference.
export function findModelCodeMismatches(title: string, productText: string): ModelCodeMismatch[] {
  const titleCodes = extractModelCodes(title)
  const productCodes = extractModelCodes(productText)
  const mismatches: ModelCodeMismatch[] = []

  for (const [prefix, titleNumbers] of titleCodes) {
    const productNumbers = productCodes.get(prefix)
    if (!productNumbers) continue
    const overlaps = [...titleNumbers].some((n) => productNumbers.has(n))
    if (!overlaps) {
      mismatches.push({ prefix, titleNumbers: [...titleNumbers], productNumbers: [...productNumbers] })
    }
  }

  return mismatches
}

// Same fix pattern as the manual S23->S26 reassignment: keep the product's
// own wording (variant/suffix) but swap in the title's generation number.
// Only handles the unambiguous case (exactly one number on each side) - a
// candidate with multiple title/product numbers for the same prefix is left
// for a human to resolve rather than guessed at.
export function deriveTargetBaseModel(productBaseModel: string, mismatch: ModelCodeMismatch): string | null {
  if (mismatch.titleNumbers.length !== 1 || mismatch.productNumbers.length !== 1) return null

  const productNumber = mismatch.productNumbers[0]
  const titleNumber = mismatch.titleNumbers[0]
  // Locates via prefix+number together (not a bare \b<number>\b) since a
  // tight code like "S26" has no word boundary between the letter and the
  // digit - matching the prefix alongside it also avoids touching an
  // unrelated occurrence of the same digits elsewhere in the name.
  const escapedPrefix = mismatch.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(${escapedPrefix})(\\s*)${productNumber}\\b`, 'i')
  const match = productBaseModel.match(pattern)
  if (!match || match.index === undefined) return null

  return (
    productBaseModel.slice(0, match.index) +
    match[1] +
    match[2] +
    titleNumber +
    productBaseModel.slice(match.index + match[0].length)
  )
}

// A listing as matched to its product: just the fields the mismatch rules read.
export interface MatchedListingNames {
  title: string
  base_model: string
  variant_tier: string | null
}

export function matchedProductText(listing: MatchedListingNames): string {
  return `${listing.base_model} ${listing.variant_tier ?? ''}`.trim()
}

export function findListingModelMismatches(listing: MatchedListingNames): ModelCodeMismatch[] {
  return findModelCodeMismatches(listing.title, matchedProductText(listing))
}

// What reassign-model-mismatches may do with one listing before it looks up
// the target product: nothing to fix ('consistent'), too many mismatched
// prefixes to pick one ('multiple'), a single mismatch whose target name
// can't be derived ('ambiguous'), or a derived target base_model to look up.
export type MismatchReassignmentPlan =
  { kind: 'consistent' } | { kind: 'multiple' } | { kind: 'ambiguous' } | { kind: 'target'; targetBaseModel: string }

export function planMismatchReassignment(listing: MatchedListingNames): MismatchReassignmentPlan {
  const mismatches = findListingModelMismatches(listing)
  if (mismatches.length === 0) return { kind: 'consistent' }
  if (mismatches.length > 1) return { kind: 'multiple' }
  const targetBaseModel = deriveTargetBaseModel(listing.base_model, mismatches[0])
  return targetBaseModel === null ? { kind: 'ambiguous' } : { kind: 'target', targetBaseModel }
}
