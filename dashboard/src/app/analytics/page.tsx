import { getPool } from '@/lib/db'
import { getSoldCountsBySubCategoryCached } from '@/lib/cachedQueries'
import type { CategoryWeeklySoldCounts } from '@/lib/queries'
import CategorySoldChart from './CategorySoldChart'

// Rows arrive from the query already ordered main-category-total desc, then
// sub-category-total desc within it (see getSoldCountsBySubCategory) - this
// is a consecutive-run collapse into sections, not a re-sort.
function groupByCategory(rows: CategoryWeeklySoldCounts[]): { category: string; items: CategoryWeeklySoldCounts[] }[] {
  const groups: { category: string; items: CategoryWeeklySoldCounts[] }[] = []
  const byCategory = new Map<string, CategoryWeeklySoldCounts[]>()
  for (const row of rows) {
    let items = byCategory.get(row.category)
    if (!items) {
      items = []
      byCategory.set(row.category, items)
      groups.push({ category: row.category, items })
    }
    items.push(row)
  }
  return groups
}

export default async function AnalyticsPage() {
  const categories = await getSoldCountsBySubCategoryCached(getPool())
  const groups = groupByCategory(categories)

  return (
    <div>
      <h1>Sold listings by category</h1>
      <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9em', maxWidth: 640 }}>
        Weekly sold count per category. &quot;Sold&quot; reflects when the scraper detected Facebook reporting a
        listing as sold, not necessarily the actual sale time.
      </p>

      {categories.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>No sold listings yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 32, marginTop: 24 }}>
          {groups.map((group) => (
            <section key={group.category}>
              <h2 style={{ fontSize: '1.1em', marginBottom: 12 }}>{group.category}</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
                {group.items.map((c) => (
                  <CategorySoldChart key={c.subCategory} {...c} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
