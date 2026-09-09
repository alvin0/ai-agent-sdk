import { describe, expect, it } from 'vitest'
import { webLinks } from '../../samples/chat-agents/backend/src/web-links.ts'

describe('research source links', () => {
  it('resolves relative links from the final page URL and decodes query entities', () => {
    expect(webLinks(`<a href="../report?q=a&amp;page=2"><b>Results</b> &amp; outlook</a>
      <a href='/prices#today'>Prices</a><a href=/prices#yesterday>Duplicate</a>`, 'https://source.test/news/latest/'))
      .toEqual([
        { url: 'https://source.test/news/report?q=a&page=2', text: 'Results & outlook' },
        { url: 'https://source.test/prices', text: 'Prices' },
      ])
  })
  it('ignores script/comment anchors, non-HTTPS targets and malformed URLs', () => {
    expect(webLinks(`<script><a href="/fake">Fake</a></script><!-- <a href="/hidden">Hidden</a> -->
      <a href="javascript:alert(1)">JS</a><a href="http://source.test">HTTP</a>
      <a href="https://user:password@source.test">Credentials</a><a href="https://[">Bad</a>
      <a href="#section">Local</a><a data-href="/not-a-link">Data</a>
      <a href="//source.test/report?x=1&#38;y=2">Valid &#x26; public</a>`, 'https://source.test/'))
      .toEqual([{ url: 'https://source.test/report?x=1&y=2', text: 'Valid & public' }])
  })
  it('bounds retained URLs, labels and link count', () => {
    const anchors = Array.from({ length: 100 }, (_, i) => `<a href="/${i}">${'x'.repeat(300)}</a>`).join('')
    const links = webLinks(`<a href="/${'x'.repeat(2100)}">Too long</a>${anchors}`, 'https://source.test/')
    expect(links).toHaveLength(40)
    expect(links[0]).toEqual({ url: 'https://source.test/0', text: 'x'.repeat(160) })
    const longLinks = webLinks(Array.from({ length: 40 }, (_, i) => `<a href="/${i}/${'q'.repeat(1500)}">Source</a>`).join(''), 'https://source.test/')
    expect(longLinks.length).toBeGreaterThan(0)
    expect(longLinks.reduce((size, link) => size + link.url.length + link.text.length, 0)).toBeLessThanOrEqual(8_000)
  })
})
