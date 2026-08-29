export type GenericReason = 'real_estate' | 'too_generic' | 'parts_accessory' | 'service'

// Brands stripped from the front of a base_model before checking it against
// GENERIC_NOUNS - "Samsung Refrigerator" and "Refrigerator" are the same
// problem (no model/series, price spans an entire product tier), so both
// need to reduce to the same bare noun. Not exhaustive - a brand missing
// from this list just means a brand+bare-category pair silently falls
// through as non-generic (safe direction: under-flagging, not over-).
const BRANDS = [
  // appliances
  'Samsung', 'LG', 'Sony', 'Panasonic', 'Sharp', 'Sanyo', 'Toshiba', 'Whirlpool', 'Haier', 'Hisense', 'TCL',
  'Kolin', 'Condura', 'Fujidenzo', 'American Home', 'Devant', 'Carrier', 'Midea', 'Astron', 'Sanden', 'Koppel',
  'Daikin', 'Fedders', 'Fujitsu', 'Kelvinator', 'National', 'Electrolux', 'Imarflex', 'Kyowa', 'Micromatic',
  'Winland', 'Standard', 'Kris', 'Asahi', 'Hanabishi', 'Camel', 'XTREME', 'Skyworth', 'Konka', 'Changhong',
  'La Germania', 'Kenwood', 'Cosmos', 'First', 'Kepler', 'Novita', 'Yasuda', 'Sunhouse', 'Nikai', 'EuroTech',
  'Tyler',
  // phones
  'Xiaomi', 'Redmi', 'Infinix', 'Tecno', 'Vivo', 'Oppo', 'Realme', 'Huawei', 'Honor', 'Nokia', 'Motorola',
  'Cherry Mobile', 'MyPhone', 'Cloudfone', 'ZTE', 'Meizu', 'OnePlus', 'Poco', 'Apple',
  // apparel/footwear/bags retailers - brand-only, no style/model, is the
  // same "spans an entire tier" problem as appliance brands above (found
  // 2026-08-29 via a live scan: "Uniqlo Clothing"/"Coach Bag" were silently
  // slipping through the appliance-focused brand list).
  'Nike', 'Adidas', 'Puma', 'New Balance', 'Converse', 'Reebok', 'Vans', 'Asics', 'Onitsuka Tiger',
  'Skechers', 'Fila', 'Under Armour', 'World Balance', 'Crocs', 'Birkenstock',
  'Uniqlo', 'H&M', 'Zara', 'Bershka', 'Shein', 'Lovito', 'Columbia', 'Forever 21', 'Mango', 'Cotton On',
  'Penshoppe', 'Bench', 'Giordano', 'Plains and Prints', 'Old Navy', 'Gap', 'GAP', "Levi's", 'Levis',
  'Coach', 'Kate Spade', 'Longchamp', 'Anello', 'Herschel', 'Baggallini',
  // furniture
  'Uratex', 'Mandaue Foam', 'Nitori', 'IKEA', 'Ikea', 'Blims', 'Wilcon',
  // vehicles - only used for bare "<Brand> <category>" pairs like "Rusi
  // Motorcycle"; a real nameplate (e.g. "Mitsubishi Strada") never matches
  // GENERIC_NOUNS after stripping, so it's unaffected by this list.
  'Honda', 'Yamaha', 'Suzuki', 'Kawasaki', 'Toyota', 'Mitsubishi', 'Ford', 'Nissan', 'Isuzu', 'Kia', 'Hyundai',
  'Rusi', 'Kymco', 'SYM', 'Motorstar', 'Tvs', 'Bajaj', 'Move It',
  'American Standard',
]
const BRAND_PREFIXES = [...new Set(BRANDS.map((b) => b.toLowerCase()))].sort((a, b) => b.length - a.length)

// Bare category nouns with no fixed price - same reasoning as the existing
// PRICE_INELIGIBLE_CATEGORIES.too_generic in flag-price-ineligible/index.ts
// ('GPU'/'Lenovo Thinkpad'/etc): a brand+bare-category pair (or a bare
// category alone) spans an entire product tier, not one product. Checked by
// EXACT match after brand-stripping, not substring/suffix - a suffix-only
// match wrongly caught real specific products that merely end in a generic
// word (e.g. "A.P.C. Diane Rue Madame Tote Bag", "Apple Magic Keyboard",
// "Adidas Multix Running Sneakers" - all real named styles/models, found
// live 2026-08-29 when a broader suffix heuristic was tried and discarded).
const GENERIC_NOUNS = new Set([
  'refrigerator', 'ref', 'freezer', 'mini fridge', 'fridge', 'chest freezer', 'deep freezer',
  'air conditioner', 'aircon', 'aircon unit', 'window type air conditioner', 'split type air conditioner',
  'washing machine', 'automatic washing machine', 'dryer', 'dehumidifier', 'water heater', 'water dispenser',
  'rice cooker', 'blender', 'juicer', 'mixer', 'stove', 'gas stove', 'gas range', 'butane stove',
  'induction cooker', 'oven', 'microwave', 'microwave oven', 'toaster', 'sandwich maker', 'waffle maker',
  'vacuum', 'vacuum cleaner', 'iron', 'flat iron', 'electric fan', 'stand fan', 'ceiling fan', 'exhaust fan',
  'fan', 'speaker', 'bluetooth speaker', 'amplifier', 'humidifier', 'air purifier', 'air fryer',
  'coffee maker', 'coffee machine', 'coffee grinder',
  'bed frame', 'mattress', 'sofa', 'sofa bed', 'sofabed', 'office chair', 'chair', 'dining table', 'dining set',
  'cabinet', 'cabinets', 'shelf', 'shelves', 'wardrobe', 'closet', 'drawer', 'drawers', 'bookshelf',
  'bunk bed', 'study table', 'computer table', 'coffee table', 'tv rack', 'tv console', 'rack',
  'organizer rack', 'shoe rack', 'shoe cabinet', 'shoe box', 'curtain', 'curtains', 'carpet', 'rug',
  'table', 'loveseat', 'glass table', 'queen bed', 'bed', 'desk', 'wood set',
  'motorcycle', 'mountain bike',
  'dress', 'dresses', 'top', 'tops', 'blouse', 'shirt', 'shirts', 't-shirt', 'polo', 'polo shirt', 'pants',
  'shorts', 'short', 'skirt', 'jacket', 'hoodie', 'sweater', 'cardigan', 'vest', 'jeans', 'leggings',
  'jumpsuit', 'romper', 'swimsuit', 'one piece swimsuit', 'uniform', 'gown', 'reception gown', 'coat',
  'trench coat', 'tracksuit', 'jersey', 'blazer', 'clothes', 'clothing',
  'bag', 'tote bag', 'sling bag', 'backpack', 'handbag', 'wallet', 'purse', 'belt', 'sunglasses', 'cap', 'hat',
  'phone', 'cellphone', 'smartphone', 'tablet', 'laptop', 'monitor', 'keyboard', 'mouse', 'charger',
  'powerbank', 'earphones', 'earbuds', 'headset', 'camera', 'router', 'modem', 'cable', 'adapter', 'lens',
  'stroller', 'crib', 'baby crib', 'highchair', 'playpen', 'walker',
  'treadmill', 'manual treadmill', 'exercise bike', 'dumbbell', 'barbell', 'yoga mat', 'helmet',
  'skateboard', 'rollerskates', 'roller skates',
  'piano', 'guitar', 'violin', 'drum set',
  'battery', 'batteries', 'filter', 'motor', 'clamp', 'coinslot', 'whiteboard', 'organizer',
  'stoneware plates', 'plates', 'toilet bowl', 'unit', 'shoes',
  // bare Apple product lines with no generation - same "spans an entire
  // product tier" problem as 'Lenovo Thinkpad' (base flag-price-ineligible
  // list) - a 2015 12" MacBook and a 2019 one are wildly different prices.
  'iphone', 'ipad', 'ipad air', 'ipad pro', 'ipad mini', 'macbook', 'macbook pro', 'macbook air',
])

// Word-boundary regexes, not substring - `"lot" in text` used to match
// inside "c[lot]hes"/"coins[lot]" before this was fixed (found live
// 2026-08-29). Order doesn't matter; first match wins.
const REAL_ESTATE_HINTS: RegExp[] = [
  /\bcondo\b/, /\bcondominium\b/, /house and lot/, /\btownhouse\b/, /\bresidences?\b/, /\bsubdivision\b/,
  /\bvillage\b/, /\blot\b/, /\bapartment\b/, /room for rent/, /\bbedspace\b/, /\bbuilding\b/, /house & lot/,
  /\b[123]br\b/, /studio unit/, /warehouse and lot/, /ancestral house/, /\bhouse\b/, /parking slot/,
  /\btower\b/, /\bproperty\b/, /\bbungalow\b/, /\bresort\b/,
]

const SERVICE_HINTS: RegExp[] = [/\bservice\b/, /\brepair\b/, /\binstallation\b/, /buying service/]

const PARTS_HINTS: RegExp[] = [
  /\baccessories\b/, /\baccessory\b/, /\bparts\b/, /\bpart\b/, /\bbundle\b/, /\bcase\b/, /\bcover\b/,
  /\bfork\b/, /\bwheels?\b/, /\btires?\b/, /\bmount\b/, /\bfilter\b/,
]

function firstMatch(hints: RegExp[], key: string): string | null {
  for (const hint of hints) {
    const m = key.match(hint)
    if (m) return m[0]
  }
  return null
}

function stripBrand(key: string): string {
  for (const brand of BRAND_PREFIXES) {
    if (key.startsWith(brand + ' ')) return key.slice(brand.length + 1).trim()
  }
  return key
}

// Detects whether a base_model is too generic to get a reliable price -
// a bare category, a brand with no model/series, real estate, a service, or
// a bundle/part/accessory rather than a single product. Returns null for
// anything that looks like a real, specific, priceable product (including
// one this function doesn't recognize - the safe default is to leave a
// product searchable, not to wrongly exclude it). Used both live (workers
// skip a paid/quota-limited price-lookup call for a detected-generic
// candidate, same as they already do for exa_no_result/groq_generic) and
// offline (detect-generic-products' read-only report, for a human to review
// before curating flag-price-ineligible.ts's list from it).
export function detectGenericBaseModel(baseModel: string): { reason: GenericReason; matched: string } | null {
  const key = baseModel.toLowerCase().trim()

  const realEstateMatch = firstMatch(REAL_ESTATE_HINTS, key)
  if (realEstateMatch) return { reason: 'real_estate', matched: realEstateMatch }

  const serviceMatch = firstMatch(SERVICE_HINTS, key)
  if (serviceMatch) return { reason: 'service', matched: serviceMatch }

  const hasDigit = /\d/.test(key)
  const stripped = stripBrand(key)

  if (!hasDigit) {
    const partsMatch = firstMatch(PARTS_HINTS, stripped)
    if (partsMatch) return { reason: 'parts_accessory', matched: partsMatch }

    if (GENERIC_NOUNS.has(stripped)) return { reason: 'too_generic', matched: stripped }
  }

  return null
}
