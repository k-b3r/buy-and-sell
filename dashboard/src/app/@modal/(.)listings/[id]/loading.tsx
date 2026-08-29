import Modal from '../../../Modal'
import { SkeletonListingDetail } from '../../../Skeleton'

export default function Loading() {
  return (
    <Modal>
      <SkeletonListingDetail showBackLink={false} />
    </Modal>
  )
}
