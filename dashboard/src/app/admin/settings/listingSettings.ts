import type { SettingsCategory } from './settingsTypes'

export const LISTING_SETTINGS: SettingsCategory = {
  id: 'listings',
  label: 'Listings',
  subgroups: [
    {
      id: 'discount_policy',
      title: 'Discount Policy',
      fields: [
        {
          key: 'discount_policy.high_discount_threshold_percent',
          label: 'High-discount bar',
          description: 'Minimum discount vs. market price for a bell-worthy notification.',
          unit: 'percent',
          min: 0,
          max: 100,
          defaultValue: 30,
        },
        {
          key: 'discount_policy.min_profit_pesos',
          label: 'Minimum profit',
          description: 'Minimum peso gap between asking price and market reference price.',
          unit: 'pesos',
          min: 0,
          defaultValue: 1000,
        },
        {
          key: 'discount_policy.min_price_pesos',
          label: 'Minimum asking price',
          description: 'Below this, a listing is never worth chasing regardless of discount math.',
          unit: 'pesos',
          min: 0,
          defaultValue: 500,
        },
        {
          key: 'discount_policy.gemini_daily_grounding_cap',
          label: 'Gemini grounding daily cap',
          description:
            'Client-side cap on Gemini Search-grounded calls per day, to stay under Google’s free allowance.',
          unit: 'count',
          min: 1,
          defaultValue: 1000,
        },
      ],
    },
  ],
}
