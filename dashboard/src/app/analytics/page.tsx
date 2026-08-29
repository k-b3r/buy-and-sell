import { getPool } from '@/lib/db'
import { getSoldCountsByCategoryCached } from '@/lib/cachedQueries'
import { groupByMainCategory } from '@/lib/categoryGroups'
import CategorySoldChart from './CategorySoldChart'

export default async function AnalyticsPage() {
  const categories = await getSoldCountsByCategoryCached(getPool())
  const groups = groupByMainCategory(categories, (c) => c.category)

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
            <section key={group.main}>
              {/* Single-sub groups (Vehicles, Real Estate, Other) skip the section
                  header - the one card inside already carries the same name. */}
              {group.items.length > 1 && <h2 style={{ fontSize: '1.1em', marginBottom: 12 }}>{group.main}</h2>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
                {group.items.map((c) => (
                  <CategorySoldChart key={c.category} {...c} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
