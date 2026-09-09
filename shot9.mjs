import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4000)
await page.screenshot({ path: '/tmp/s1-home.png' })
console.log('errors:', errors.slice(0, 6))
await browser.close()
