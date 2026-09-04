// Must match src/products.ts's PRODUCT_CATEGORIES (the root project's extraction
// enum) and server/queries.ts's copy, which the category SQL binds against.
// The three packages share no import path, so this list is duplicated rather
// than reaching across a package boundary.
//
// Its own module rather than living in queries.ts: the filter dropdowns that
// render it are client components, and queries.ts is server-only now (it
// reads REFRESH_API_KEY).
export const PRODUCT_CATEGORIES = [
  'Phones & Tablets',
  'Computers & Laptops',
  'PC Components',
  'Cameras & Drones',
  'Audio',
  'Gaming',
  'TVs & Monitors',
  'Appliances',
  'Vehicles',
  'Real Estate',
  'Fashion',
  'Fitness & Outdoor',
  'Furniture & Home',
  'Other',
] as const
