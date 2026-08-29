import { SkeletonGrid } from './Skeleton'

export default function Loading() {
  return (
    <div>
      <h1>Products</h1>
      <SkeletonGrid count={12} minWidth={220} />
    </div>
  )
}
