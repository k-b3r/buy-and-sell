// Mirrors db/schema.sql's categories.parent_id seeding exactly (2026-08-28
// migration) - main category is a pure presentation-layer grouping over the
// 14 sub-categories every product already has, so it's duplicated here as a
// static structure rather than queried, same tradeoff PRODUCT_CATEGORIES in
// queries.ts already makes (no shared import path across the schema/app
// boundary for something this static). Single-sub groups (Vehicles, Real
// Estate, Other) are their own main in the DB (parent_id stays NULL) - kept
// as one-item groups here too so callers don't need a separate code path.
export const CATEGORY_GROUPS: { main: string; subs: readonly string[] }[] = [
  { main: 'Phones & Computing', subs: ['Phones & Tablets', 'Computers & Laptops', 'PC Components'] },
  { main: 'Home Electronics & Gaming', subs: ['TVs & Monitors', 'Audio', 'Gaming', 'Cameras & Drones'] },
  { main: 'Home & Furniture', subs: ['Appliances', 'Furniture & Home'] },
  { main: 'Vehicles', subs: ['Vehicles'] },
  { main: 'Real Estate', subs: ['Real Estate'] },
  { main: 'Fashion & Lifestyle', subs: ['Fashion', 'Fitness & Outdoor'] },
  { main: 'Other', subs: ['Other'] },
]

const SUB_TO_MAIN = new Map(CATEGORY_GROUPS.flatMap((g) => g.subs.map((s) => [s, g.main])))

// Order follows CATEGORY_GROUPS, not first-encountered-in-items - so the
// same main-category sections render in the same order regardless of which
// products/categories happen to have data this week.
export function groupByMainCategory<T>(items: T[], getCategory: (item: T) => string): { main: string; items: T[] }[] {
  const byMain = new Map<string, T[]>()
  for (const item of items) {
    const main = SUB_TO_MAIN.get(getCategory(item)) ?? getCategory(item)
    const bucket = byMain.get(main)
    if (bucket) bucket.push(item)
    else byMain.set(main, [item])
  }
  return CATEGORY_GROUPS.map((g) => ({ main: g.main, items: byMain.get(g.main) ?? [] })).filter((g) => g.items.length > 0)
}
