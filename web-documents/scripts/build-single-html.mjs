import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const distDir = join(root, '.vitepress/dist')
const sidebar = JSON.parse(readFileSync(join(root, '.vitepress/sidebar.json'), 'utf8'))

function linkToDistFile(link) {
  const clean = link.endsWith('/') ? `${link}index` : link
  return join(distDir, `${clean.replace(/^\//, '')}.html`)
}

function extractVpDoc(html) {
  const startMatch = html.match(/<div[^>]*class="vp-doc[^"]*"[^>]*>/)
  if (!startMatch) return null
  const start = startMatch.index
  let i = start + startMatch[0].length
  let depth = 1
  const tagRe = /<div[^>]*>|<\/div>/g
  tagRe.lastIndex = i
  let m
  while ((m = tagRe.exec(html))) {
    if (m[0] === '</div>') depth--
    else depth++
    if (depth === 0) {
      return html.slice(i, m.index)
    }
  }
  return null
}

function collectPages(items, lang, acc = []) {
  for (const item of items) {
    if (item.link) acc.push({ text: item.text, link: item.link })
    if (item.items) collectPages(item.items, lang, acc)
  }
  return acc
}

function renderLang(lang) {
  const pages = collectPages(sidebar[lang], lang)
  let body = ''
  let toc = ''
  for (const page of pages) {
    const file = linkToDistFile(page.link)
    if (!existsSync(file)) {
      console.warn(`missing: ${file}`)
      continue
    }
    const html = readFileSync(file, 'utf8')
    const content = extractVpDoc(html)
    if (!content) {
      console.warn(`no vp-doc content in: ${file}`)
      continue
    }
    const id = page.link.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')
    toc += `<li><a href="#${id}">${page.text}</a></li>\n`
    body += `<section id="${id}" class="doc-page">\n<h6 class="page-path">${page.link}</h6>\n${content}\n</section>\n`
  }
  return { toc, body }
}

const langLabels = { en: 'English', vi: 'Tiếng Việt' }
let langSections = ''
let langNav = ''
for (const lang of Object.keys(sidebar)) {
  const { toc, body } = renderLang(lang)
  langNav += `<button class="lang-btn" data-lang="${lang}" onclick="switchLang('${lang}')">${langLabels[lang] ?? lang}</button>\n`
  langSections += `
  <div class="lang-block" data-lang="${lang}" ${lang === 'vi' ? '' : 'hidden'}>
    <nav class="toc"><h2>Mục lục</h2><ul>${toc}</ul></nav>
    <main class="content">${body}</main>
  </div>`
}

const html = `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>AI Agent SDK — Docs (single file)</title>
<style>
:root { color-scheme: light dark; }
body { max-width: 1400px; margin: 0 auto; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.7; color: #24292e; background: #fff; }
@media (prefers-color-scheme: dark) { body { color: #dbdbdb; background: #1b1b1f; } a { color: #7dd3fc; } pre, code { background: #161618 !important; } table th, table td { border-color: #3c3f44 !important; } .toc { border-color: #3c3f44 !important; } }
.top-bar { position: sticky; top: 0; background: inherit; padding: 10px 20px; border-bottom: 1px solid #e2e2e3; z-index: 10; display: flex; gap: 8px; align-items: center; }
.lang-btn { padding: 6px 14px; border-radius: 6px; border: 1px solid #999; background: transparent; color: inherit; cursor: pointer; font-size: 14px; }
.lang-btn.active { background: #3c8772; color: #fff; border-color: #3c8772; }
.lang-block { display: flex; gap: 24px; padding: 20px; align-items: flex-start; }
.toc { position: sticky; top: 60px; flex: 0 0 280px; max-height: calc(100vh - 80px); overflow-y: auto; border-right: 1px solid #e2e2e3; padding-right: 16px; }
.toc h2 { font-size: 15px; margin-top: 0; }
.toc ul { list-style: none; padding-left: 0; margin: 0; }
.toc li { margin: 4px 0; font-size: 13px; }
.toc a { text-decoration: none; color: inherit; opacity: 0.8; }
.toc a:hover { opacity: 1; text-decoration: underline; }
.content { flex: 1; min-width: 0; }
.doc-page { padding: 24px 0; border-bottom: 1px solid #e2e2e3; }
.page-path { font-size: 11px; text-transform: none; opacity: 0.45; margin: 0 0 8px; font-weight: 400; }
.content h1 { font-size: 28px; margin-top: 0; }
.content h2 { font-size: 22px; border-top: 1px solid #e2e2e3; padding-top: 20px; margin-top: 28px; }
.content h3 { font-size: 18px; }
.content pre { background: #f6f8fa; padding: 14px; border-radius: 8px; overflow-x: auto; }
.content code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.88em; }
.content :not(pre) > code { background: rgba(125,125,125,0.15); padding: 2px 5px; border-radius: 4px; }
.content table { border-collapse: collapse; width: 100%; margin: 16px 0; }
.content th, .content td { border: 1px solid #d8d8d8; padding: 6px 10px; text-align: left; }
.content img { max-width: 100%; }
.content a { color: #3c8772; }
.content blockquote { border-left: 3px solid #ccc; margin: 0; padding-left: 16px; opacity: 0.85; }
.header-anchor { display: none; }
.lang-block[hidden] { display: none !important; }
@media (max-width: 900px) { .lang-block { flex-direction: column; } .toc { position: static; max-height: none; border-right: none; border-bottom: 1px solid #e2e2e3; padding-bottom: 16px; } }
</style>
</head>
<body>
<div class="top-bar">
  <strong>AI Agent SDK Docs</strong>
  ${langNav}
</div>
${langSections}
<script>
function switchLang(lang) {
  document.querySelectorAll('.lang-block').forEach(el => { el.hidden = el.dataset.lang !== lang })
  document.querySelectorAll('.lang-btn').forEach(el => el.classList.toggle('active', el.dataset.lang === lang))
  try { localStorage.setItem('docs-lang', lang) } catch (e) {}
}
(function () {
  let saved = 'vi'
  try { saved = localStorage.getItem('docs-lang') || 'vi' } catch (e) {}
  switchLang(saved)
})()
</script>
</body>
</html>
`

const outPath = join(root, 'ai-agent-sdk-docs.html')
writeFileSync(outPath, html, 'utf8')
console.log(`written: ${outPath} (${(html.length / 1024 / 1024).toFixed(2)} MB)`)
