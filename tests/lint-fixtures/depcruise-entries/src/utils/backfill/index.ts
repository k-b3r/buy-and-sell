import type { Row } from '../../modules/collection/store/rows'

export function backfill(row: Row): number {
  return row.id
}
