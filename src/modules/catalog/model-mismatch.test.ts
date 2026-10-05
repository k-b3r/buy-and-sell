import { describe, expect, it } from 'vitest'
import { findModelCodeMismatches, deriveTargetBaseModel } from './model-mismatch'

describe('findModelCodeMismatches', () => {
  it('flags the real S23-vs-S26 mismatch found manually in listing 1000000000000002', () => {
    const result = findModelCodeMismatches('Samsung S23 ULTRA Dual Sim 256gb', 'Samsung Galaxy S26 Ultra')
    expect(result).toEqual([{ prefix: 's', titleNumbers: ['23'], productNumbers: ['26'] }])
  })

  it('does not flag when the generation number matches', () => {
    expect(findModelCodeMismatches('iPhone 13 Pro Max 128GB', 'iPhone 13 Pro Max')).toEqual([])
  })

  it('does not flag when title and product share no model-line prefix', () => {
    expect(findModelCodeMismatches('Room for rent near SM', 'Studio Unit Condo')).toEqual([])
  })

  it('ignores digit-before-letter specs like storage, network gen, and resolution', () => {
    expect(findModelCodeMismatches('Samsung A54 5G 128GB 4K display', 'Samsung Galaxy A54')).toEqual([])
  })

  it('flags a tight-form mismatch (A54 vs A14)', () => {
    expect(findModelCodeMismatches('Samsung A54 5G', 'Samsung Galaxy A14')).toEqual([
      { prefix: 'a', titleNumbers: ['54'], productNumbers: ['14'] },
    ])
  })

  it('flags a loose-form mismatch (Note 20 vs Note 10)', () => {
    expect(findModelCodeMismatches('Samsung Galaxy Note 20 Ultra', 'Samsung Galaxy Note 10')).toEqual([
      { prefix: 'note', titleNumbers: ['20'], productNumbers: ['10'] },
    ])
  })
})

describe('deriveTargetBaseModel', () => {
  it('swaps in the title generation number, keeping the product wording (S23-vs-S26 case)', () => {
    const mismatch = { prefix: 's', titleNumbers: ['23'], productNumbers: ['26'] }
    expect(deriveTargetBaseModel('Samsung Galaxy S26 Ultra', mismatch)).toBe('Samsung Galaxy S23 Ultra')
  })

  it('handles the plain iPhone 14-vs-13 case', () => {
    const mismatch = { prefix: 'iphone', titleNumbers: ['14'], productNumbers: ['13'] }
    expect(deriveTargetBaseModel('iPhone 13', mismatch)).toBe('iPhone 14')
  })

  it('returns null when either side has more than one number for the prefix', () => {
    const mismatch = { prefix: 's', titleNumbers: ['23', '24'], productNumbers: ['26'] }
    expect(deriveTargetBaseModel('Samsung Galaxy S26 Ultra', mismatch)).toBeNull()
  })

  it('returns null when the product number is not found in the base model text', () => {
    const mismatch = { prefix: 's', titleNumbers: ['23'], productNumbers: ['99'] }
    expect(deriveTargetBaseModel('Samsung Galaxy S26 Ultra', mismatch)).toBeNull()
  })
})
