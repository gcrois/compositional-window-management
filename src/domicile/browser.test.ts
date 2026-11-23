import { expect, it } from 'vitest'
import { addressOf } from './browser'

it('reads typed text as an address or a search', () => {
  expect(addressOf('https://example.com/a?b')).toBe('https://example.com/a?b')
  expect(addressOf('about:blank')).toBe('about:blank')
  expect(addressOf('example.com')).toBe('https://example.com')
  expect(addressOf('  news.ycombinator.com/item?id=1 ')).toBe('https://news.ycombinator.com/item?id=1')
  expect(addressOf('localhost:5173')).toBe('https://localhost:5173')
  expect(addressOf('homelab:8080/x')).toBe('https://homelab:8080/x')
  expect(addressOf('nixos linger option')).toBe('https://duckduckgo.com/?q=nixos%20linger%20option')
  expect(addressOf('tmux')).toBe('https://duckduckgo.com/?q=tmux')
})
