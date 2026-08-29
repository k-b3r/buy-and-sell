import { SkeletonGrid, SkeletonLine } from '../../Skeleton'

export default function Loading() {
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <SkeletonLine width={120} height={16} />
      </div>
      <div style={{ margin: '0 0 12px' }}>
        <SkeletonLine width="40%" height={28} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '12px 0 24px' }}>
        <SkeletonLine width={220} height={14} />
        <SkeletonLine width={200} height={14} />
      </div>
      <div style={{ margin: '0 0 12px' }}>
        <SkeletonLine width={140} height={20} />
      </div>
      <div style={{ marginTop: 16 }}>
        <SkeletonGrid count={8} minWidth={180} />
      </div>
    </div>
  )
}
