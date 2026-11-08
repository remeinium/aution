import { describe, expect, it } from 'vitest'
import { currentEndpoint } from '../src/lib/endpoint'

describe('currentEndpoint', () => {
  it('moves the retired address to the new host', () => {
    expect(currentEndpoint('https://vb.kusaldarshana.com')).toBe('https://aution.remeinium.com')
    expect(currentEndpoint('vb.kusaldarshana.com/')).toBe('https://aution.remeinium.com')
    expect(currentEndpoint('https://VB.kusaldarshana.com')).toBe('https://aution.remeinium.com')
  })
  it('leaves everything else alone', () => {
    expect(currentEndpoint('')).toBe('')
    expect(currentEndpoint('https://aution.remeinium.com')).toBe('https://aution.remeinium.com')
    expect(currentEndpoint('http://192.168.1.5:8787')).toBe('http://192.168.1.5:8787')
    expect(currentEndpoint('https://notes.example.com')).toBe('https://notes.example.com')
  })
})
