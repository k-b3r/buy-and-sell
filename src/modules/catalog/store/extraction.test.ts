import { getExtractionCandidates } from './extraction'

test('getExtractionCandidates returns pending listings with condition/price_amount for the inline discount check', async () => {
  const calls: { sql: string; params: unknown[] }[] = []
  const db = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params })
      return {
        rows: [
          { id: '1', title: 'RTX 3060', description: 'for sale', condition: 'Used - Good', price_amount: '15000' },
        ],
      }
    },
  }

  const result = await getExtractionCandidates(db)

  expect(calls[0].sql).toContain('WHERE product_id IS NULL')
  expect(result).toEqual([
    { id: '1', title: 'RTX 3060', description: 'for sale', condition: 'Used - Good', price_amount: 15000 },
  ])
})

test('getExtractionCandidates coerces a null price_amount to null, not NaN', async () => {
  const db = {
    query: async () => ({
      rows: [{ id: '1', title: 'RTX 3060', description: null, condition: null, price_amount: null }],
    }),
  }

  const result = await getExtractionCandidates(db)

  expect(result[0].price_amount).toBeNull()
})
