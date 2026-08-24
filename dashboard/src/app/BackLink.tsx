import Link from 'next/link'
import { backIconStyle } from './backIconStyle'
import BackIcon from './BackIcon'

export default function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} aria-label={label} title={label} style={backIconStyle}>
      <BackIcon />
    </Link>
  )
}
