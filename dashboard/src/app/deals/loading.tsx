import { SkeletonDealRow } from '../Skeleton'

export default function Loading() {
  return (
    <div>
      <h1>Deals</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="skeleton" style={{ width: 140, height: 34, borderRadius: 4 }} />
        <div className="skeleton" style={{ width: 170, height: 34, borderRadius: 4 }} />
        <div className="skeleton" style={{ width: 130, height: 34, borderRadius: 4 }} />
        <div className="skeleton" style={{ width: 140, height: 34, borderRadius: 4 }} />
        <div className="skeleton" style={{ width: 70, height: 34, borderRadius: 4 }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {Array.from({ length: 8 }, (_, i) => (
          <SkeletonDealRow key={i} />
        ))}
      </div>
    </div>
  )
}
