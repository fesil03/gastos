import { describe, it, expect } from 'vitest'
import { parseTypedAmount } from './money'

describe('parseTypedAmount', () => {
  it('reads the shapes people type into the budget field', () => {
    expect(parseTypedAmount('5000')).toBe(500_000)
    expect(parseTypedAmount('5000.5')).toBe(500_050)
    expect(parseTypedAmount('5000,5')).toBe(500_050)
    expect(parseTypedAmount('5.000')).toBe(500_000)
    expect(parseTypedAmount('5.000,50')).toBe(500_050)
    expect(parseTypedAmount('5,000.50')).toBe(500_050)
    expect(parseTypedAmount('5,000')).toBe(500_000)
    expect(parseTypedAmount('¥ 4 500')).toBe(450_000)
    expect(parseTypedAmount('R$ 1.200,00')).toBe(120_000)
    expect(parseTypedAmount('12.5')).toBe(1_250)
  })

  it('rejects empty, zero and junk', () => {
    expect(parseTypedAmount('')).toBeNull()
    expect(parseTypedAmount('0')).toBeNull()
    expect(parseTypedAmount('abc')).toBeNull()
    expect(parseTypedAmount('5.000.00,1,2')).toBeNull()
  })
})
