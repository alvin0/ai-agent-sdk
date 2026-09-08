/** Bounded source navigation for fetch_url; never execute or fetch page links. */
export function webLinks(html: string, baseUrl: string): readonly { url: string; text: string }[] {
  const clean = html.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  const links: { url: string; text: string }[] = []
  let characters = 0
  const seen = new Set<string>()
  const anchors = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))[^>]*>([\s\S]*?)<\/a\s*>/gi
  for (const match of clean.matchAll(anchors)) {
    const href = entities(match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (!href || href.startsWith('#')) continue
    try {
      const target = new URL(href, baseUrl)
      if (target.protocol !== 'https:' || target.username || target.password) continue
      target.hash = ''
      const url = target.toString()
      if (url.length > 2_000 || seen.has(url)) continue
      seen.add(url)
      const text = entities((match[4] ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 160)
      if (characters + url.length + text.length > 8_000) continue
      characters += url.length + text.length
      links.push({ url, text })
      if (links.length === 40) break
    } catch { /* Ignore malformed links; a bad anchor must not discard the page. */ }
  }
  return links
}

function entities(text: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' }
  return text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (whole, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? whole
    const hex = entity[1]?.toLowerCase() === 'x'
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole
  })
}
