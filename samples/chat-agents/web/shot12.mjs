import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } })
const errors = []
page.on('pageerror', e => errors.push(String(e)))
await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4000)
// new conversation, send a prompt
await page.click('[aria-label="New chat"]')
await page.waitForTimeout(800)
await page.fill('textarea', 'Read README.md in the workspace and quote its first line.')
await page.keyboard.press('Enter')
await page.waitForTimeout(20000)
await page.screenshot({ path: '/tmp/t1-run.png' })
// reload: transcript must come back from the server
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(4000)
await page.screenshot({ path: '/tmp/t2-reload.png' })
// switch to the older conversation
const rows = page.locator('.AppShell-module__ZlZtQG__conversationOpen, [class*="conversationOpen"]')
console.log('conversation rows:', await rows.count())
await rows.nth(1).click()
await page.waitForTimeout(2500)
await page.screenshot({ path: '/tmp/t3-switch.png' })
console.log('errors:', errors.slice(0, 5))
await browser.close()
