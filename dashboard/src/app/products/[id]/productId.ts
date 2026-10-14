// The page's [id] segment as a product id, or null when it can't name one
// (the server rejects those with a 400, which would surface as a 500 page).
export function parseProductId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}
