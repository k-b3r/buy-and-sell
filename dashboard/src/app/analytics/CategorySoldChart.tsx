'use client'

import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import type { CategoryWeeklySoldCounts } from '@/lib/queries'

// Count and price are different units (items vs currency) - never sharing one
// y-axis (a dual-axis chart is misleading), so each category gets two
// stacked single-series mini-charts on the same x-axis weeks instead of one
// chart with two scales. Color encodes the metric, not the category: count
// is always --color-accent, price is always --color-signal, consistently
// across every card - identity (which category) is carried by the card's
// title, not by hue, so 14 categories never need 14 distinguishable colors.
function MiniChart({
  data,
  dataKey,
  color,
  tooltipLabel,
  tickFormatter,
  tooltipFormatter,
}: {
  data: { week: string; value: number | null }[]
  dataKey: string
  color: string
  tooltipLabel: string
  tickFormatter: (v: number) => string
  tooltipFormatter: (v: number) => string
}) {
  // connectNulls draws nothing at all when every point is null - which reads
  // as a broken/empty chart, not "no data yet" (e.g. a category whose only
  // sold listings that week all had placeholder-pattern prices, excluded
  // from the average same as everywhere else in this codebase). Say so
  // explicitly instead of rendering an axis with no line.
  if (data.every((d) => d.value === null)) {
    return (
      <div
        style={{
          height: 110,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-text-muted)',
          fontSize: '0.85em',
        }}
      >
        No price data
      </div>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={110}>
      <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="var(--color-border)" strokeDasharray="0" vertical={false} />
        <XAxis
          dataKey="week"
          tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
          axisLine={{ stroke: 'var(--color-border)' }}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          allowDecimals={false}
          tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }}
          axisLine={false}
          tickLine={false}
          width={48}
          tickFormatter={(v: number) => tickFormatter(v)}
        />
        <Tooltip
          contentStyle={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 6,
            fontSize: '0.85em',
            color: 'var(--color-text)',
          }}
          labelStyle={{ color: 'var(--color-text-muted)' }}
          formatter={(value) => [value === null ? 'No data' : tooltipFormatter(value as number), tooltipLabel]}
        />
        <Area
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={2}
          fill={color}
          fillOpacity={0.1}
          // Weekly buckets are discrete, sparse data, not a continuous
          // signal - a category with sold data in only one week has just
          // one non-null point, which draws no visible line segment at all
          // (a line needs two ends). Dots make every week's value legible
          // on its own, not just when it happens to have a neighbor.
          // recharts otherwise inherits the Area's own fillOpacity (0.1, the
          // wash) onto the dot too, since it spreads the Area's remaining
          // props down into <Dot> - the dot needs its own opacity set
          // explicitly or it renders as a near-invisible speck, confirmed
          // live via screenshot.
          dot={{ r: 3, fill: color, fillOpacity: 1, strokeWidth: 0 }}
          activeDot={{ r: 4, fillOpacity: 1, stroke: 'var(--color-surface)', strokeWidth: 2 }}
          connectNulls
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export default function CategorySoldChart({ subCategory, totalSold, weeklyCounts }: CategoryWeeklySoldCounts) {
  const weeks = weeklyCounts.map((w) => new Date(w.weekStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  const countData = weeklyCounts.map((w, i) => ({ week: weeks[i], value: w.count }))
  const priceData = weeklyCounts.map((w, i) => ({ week: weeks[i], value: w.avgPrice }))
  const formatPriceFull = (v: number) => `₱${Math.round(v).toLocaleString()}`
  const formatPriceCompact = (v: number) =>
    `₱${Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v)}`

  return (
    <div
      style={{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 8,
        padding: 16,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: '1em' }}>{subCategory}</h2>
        <span className="mono" style={{ color: 'var(--color-text-muted)', fontSize: '0.85em' }}>
          {totalSold} sold
        </span>
      </div>

      <div style={{ fontSize: '0.75em', color: 'var(--color-text-muted)', marginBottom: -4 }}>Sold</div>
      <MiniChart
        data={countData}
        dataKey="value"
        color="var(--color-accent)"
        tooltipLabel="Sold"
        tickFormatter={(v) => String(v)}
        tooltipFormatter={(v) => String(v)}
      />

      <div style={{ fontSize: '0.75em', color: 'var(--color-text-muted)', marginTop: 8, marginBottom: -4 }}>
        Avg asking price
      </div>
      <MiniChart
        data={priceData}
        dataKey="value"
        color="var(--color-signal)"
        tooltipLabel="Avg asking price"
        tickFormatter={formatPriceCompact}
        tooltipFormatter={formatPriceFull}
      />
    </div>
  )
}
