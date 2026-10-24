// What the extraction model is told, and the schema its answer must satisfy.
// Prose first on purpose: this is the file to edit when extraction quality needs
// retuning. The parsing and alias rules stay in domain/extraction.ts.
import { PRODUCT_CATEGORIES, SUB_CATEGORIES } from '../domain/products'

export interface ExtractionInput {
  id: string
  title: string
  description: string
}

export function buildExtractionPrompt(listings: ExtractionInput[]): string {
  const lines = listings.map(formatListingLine).join('\n')
  return `Extract the base product model from each Facebook Marketplace listing below.
Return ONLY the core product line/model - strip seller phrases ("RUSH", "FOR SALE"),
condition, price, storage/color, and edition/variant details (write "RTX 3060" not
"RTX 3060 OC Asus"; write "iPhone 13" not "iPhone 13 128GB Blue"). If genuinely
unidentifiable even from the description, use a general category instead ("Laptop",
"Bicycle") rather than guessing wrong.

Also extract a "variant" for each listing ONLY when the title/description clearly
signals a specific edition/trim that plausibly affects its value (e.g. "Founders
Edition", "Custom AIB/OC", "Pro", "Max"). Leave variant as an empty string ""
when no such signal is present - do NOT use storage capacity or color as a variant.

If the base model name itself ends in a known trim/tier word, move that word into
variant instead of leaving it in base_model - the same product must always produce
the same base_model regardless of which trim was in the listing title. For example:
- "iPhone 14 Plus" -> base_model: "iPhone 14", variant: "Plus"
- "iPad 9th Gen" / "iPad 9th Generation" -> base_model: "iPad", variant: "9th Gen"
- "MacBook Air M2" -> base_model: "MacBook Air", variant: "M2"
- "Galaxy S23 Ultra" -> base_model: "Samsung Galaxy S23", variant: "Ultra"
Never repeat the same trim word in both base_model and variant.

Only record a network band ("5G"/"4G") as variant when the same base model is
genuinely sold in more than one band - if every listing you've seen for that model
is 5G, leave variant empty rather than tagging every one of them "5G".

Also assign a "category" for each listing - exactly one of: ${PRODUCT_CATEGORIES.join(', ')}.
Use "Other" if none genuinely fit rather than forcing a bad match.

Also assign a finer "sub_category" for each listing - exactly one of: ${SUB_CATEGORIES.join(', ')}.
Pick whichever fits best regardless of which "category" you chose above (e.g. a listing you put
under "Computers & Laptops" might still be "Graphics Cards" or "Consoles" if that's a better fit -
the two fields are judged independently). Use "Other" if none genuinely fit.

Listings:
${lines}`
}

const DESCRIPTION_TRUNCATE_LENGTH = 150

function formatListingLine(l: ExtractionInput): string {
  const desc = l.description.slice(0, DESCRIPTION_TRUNCATE_LENGTH)
  return `[id: ${l.id}] title: "${l.title}" desc: "${desc}"`
}

// Root type must be 'object', not 'array' - confirmed live 2026-09-03 via a
// direct call: Groq hard-rejects any response_format schema whose top level
// isn't 'object' ("schema must have type 'object' and not have
// 'oneOf'/'anyOf'/'enum'/'not' at the top level"), on every model, not just
// a specific one - this had silently been failing every single Groq call
// and falling through to Gemini instead. Wrapped in the same {results: [...]}
// envelope every other schema in this file already uses; variant is nullable
// rather than omitted from `required`, since strict mode requires every
// property be listed there.
export const EXTRACTION_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          base_model: { type: 'string' },
          variant: { type: ['string', 'null'] },
          category: { type: 'string', enum: PRODUCT_CATEGORIES },
          sub_category: { type: 'string', enum: SUB_CATEGORIES },
        },
        required: ['id', 'base_model', 'variant', 'category', 'sub_category'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const
