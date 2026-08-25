import { expect, test } from 'vitest'
import { matchesNegotiableKeyword } from '../src/negotiable-keywords'

test('matches "negotiable"', () => {
  expect(matchesNegotiableKeyword('Price is negotiable, DM me')).toBe('negotiable')
})

test('matches "nego" (common PH Marketplace shorthand)', () => {
  expect(matchesNegotiableKeyword('Presyo pwede pa mag-nego')).toBe('nego')
})

test('matches "nego" case-insensitively', () => {
  expect(matchesNegotiableKeyword('NEGO LANG PO')).toBe('nego')
})

test('matches "OBO"', () => {
  expect(matchesNegotiableKeyword('₱5000 OBO')).toBe('obo')
})

test('matches dotted "O.B.O."', () => {
  expect(matchesNegotiableKeyword('₱5000 O.B.O.')).toBe('obo')
})

test('matches "best offer"', () => {
  expect(matchesNegotiableKeyword('Selling to the best offer')).toBe('best offer')
})

test('matches "open to offers"', () => {
  expect(matchesNegotiableKeyword('Open to offers, just message me')).toBe('open to offers')
})

test('matches "make an offer" and the shorter "make offer"', () => {
  expect(matchesNegotiableKeyword('Make an offer and let\'s talk')).toBe('make an offer')
  expect(matchesNegotiableKeyword('make offer below')).toBe('make an offer')
})

test('matches negotiate/negotiating/negotiation verb forms', () => {
  expect(matchesNegotiableKeyword('Willing to negotiate the price')).toBe('negotiate')
  expect(matchesNegotiableKeyword('Still negotiating with another buyer')).toBe('negotiate')
})

test('does not match plain text with no negotiation signal', () => {
  expect(matchesNegotiableKeyword('Sony WH-1000XM6, barely used, comes with case.')).toBeNull()
})

test('does not match "nego" as a substring of an unrelated word', () => {
  expect(matchesNegotiableKeyword('This stereo negotiator thing')).not.toBe('nego')
})

test('returns null for null/empty text', () => {
  expect(matchesNegotiableKeyword(null)).toBeNull()
  expect(matchesNegotiableKeyword('')).toBeNull()
})

test('checks title and description together', () => {
  expect(matchesNegotiableKeyword('RTX 3060', 'nego pa presyo')).toBe('nego')
})
