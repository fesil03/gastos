// End-to-end smoke test of the built app in headless Chromium.
// Run: npm run build && npm run smoke   (set CHROMIUM_PATH to use a specific binary)
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { join, extname } from 'node:path'

const dist = new URL('../dist', import.meta.url).pathname
const csv = new URL('../fixtures/gastos_report_2026-05-02_203027.csv', import.meta.url).pathname
mkdirSync('screenshots', { recursive: true })

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' }
// Serve dist under the same sub-path the build was made for (GASTOS_BASE, e.g. /gastos/ on GitHub Pages).
const basePath = process.env.GASTOS_BASE ?? '/'
const server = createServer((req, res) => {
  let url = req.url.split('?')[0]
  if (basePath !== '/' && url.startsWith(basePath.slice(0, -1))) url = url.slice(basePath.length - 1) || '/'
  let p = join(dist, url)
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(dist, 'index.html')
  res.setHeader('Content-Type', types[extname(p)] ?? 'application/octet-stream')
  res.end(readFileSync(p))
}).listen(4173)
const BASE = `http://localhost:4173${basePath}`

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, acceptDownloads: true })
const page = await ctx.newPage()
const errors = []
const hosts = new Set()
page.on('request', (r) => hosts.add(new URL(r.url()).host))
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

let failures = 0
const check = (name, ok, detail = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++ }
const text = (sel) => page.textContent(sel)
const shot = (name) => page.screenshot({ path: `screenshots/${name}.png`, fullPage: true })

// ---------- Phase 1: import ----------
await page.goto(BASE + '#settings')
await page.setInputFiles('[data-testid=csv-input]', csv)
await page.waitForSelector('[data-testid=report]')
check('P1 import 1617 rows', (await text('[data-testid=imported]')) === '1617')
await page.waitForFunction(() => document.querySelector('[data-testid=tx-count]')?.textContent === '1617')
check('P1 41 categories', (await text('[data-testid=cat-count]')) === '41')
await page.setInputFiles('[data-testid=csv-input]', csv)
await page.waitForFunction(() => document.querySelector('[data-testid=imported]')?.textContent === '0')
check('P1 re-import no-op', (await text('[data-testid=skipped]')) === '1617')
check('P1 untracked period seeded once', (await page.$$('[data-testid=untracked-list] li')).length === 1, (await text('[data-testid=untracked-list]')) ?? '')
await shot('p1-import')

// ---------- Phase 2: entry ----------
await page.click('[data-testid=tab-entry]')
await page.waitForSelector('[data-testid=chips] [data-testid=chip]')
const chipNames = await page.$$eval('[data-testid=chips] [data-testid=chip]', (els) => els.map((e) => e.textContent.trim()))
check('P2 eight ranked chips', chipNames.length === 8, chipNames.join(' | '))
await shot('p2-entry')

const countTx = async () => {
  await page.click('[data-testid=tab-settings]')
  await page.waitForSelector('[data-testid=tx-count]')
  const n = Number(await text('[data-testid=tx-count]'))
  await page.click('[data-testid=tab-entry]')
  await page.waitForSelector('[data-testid=keypad]')
  return n
}

// Time the critical path: keypad taps → chip tap → toast.
const t0 = Date.now()
for (const k of ['1', '8', '.', '8']) await page.click(`[data-key="${k}"]`)
check('P2 amount display', (await text('[data-testid=amount-display]')) === '18,8')
const cafe = await page.waitForSelector('[data-testid=chips] [data-testid=chip]:has-text("Café")')
await cafe.click()
await page.waitForSelector('[data-testid=toast]')
const elapsed = Date.now() - t0
const toastText = await text('[data-testid=toast]')
check('P2 saved via chip tap', toastText.includes('¥18,80') && toastText.includes('Café'), `${toastText} in ${elapsed} ms`)
check('P2 keypad cleared after save', (await text('[data-testid=amount-display]')) === '0')
check('P2 count 1618', (await countTx()) === 1618)

// Undo
for (const k of ['5']) await page.click(`[data-key="${k}"]`)
await page.$('[data-testid=chips] [data-testid=chip]:has-text("Táxi")').then((c) => c.click())
await page.waitForSelector('[data-testid=toast-action]')
await page.click('[data-testid=toast-action]')
await page.waitForFunction(() => document.querySelector('[data-testid=toast]')?.textContent?.includes('Desfeito'))
check('P2 undo removed it', (await countTx()) === 1618)

// Yesterday toggle + note via "more"
await page.click('[data-testid=date-toggle]')
check('P2 date toggle → Ontem', (await text('[data-testid=date-toggle]')) === 'Ontem')
await page.click('[data-testid=more-toggle]')
await page.fill('[data-testid=note-input]', 'Kaya Toast')
check('P2 no payment-method control in the drawer', (await page.$('[data-testid^=method-]')) === null)
for (const k of ['2', '2']) await page.click(`[data-key="${k}"]`)
await page.$('[data-testid=chips] [data-testid=chip]:has-text("FamilyMart")').then((c) => c.click())
await page.waitForSelector('[data-testid=toast]')
check('P2 saved with yesterday + note', (await text('[data-testid=toast]')).includes('ontem'))
check('P2 count 1619', (await countTx()) === 1619)

// Long-press quick-repeat: re-logs the most recent Café amount (18,80 from the row we just added)
const cafe2 = await page.waitForSelector('[data-testid=chips] [data-testid=chip]:has-text("Café")')
const box = await cafe2.boundingBox()
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await page.mouse.down()
await page.waitForTimeout(700)
await page.mouse.up()
await page.waitForSelector('[data-testid=toast]')
check('P2 long-press repeats last amount', (await text('[data-testid=toast]')).includes('¥18,80'))
check('P2 count 1620', (await countTx()) === 1620)

// Select-then-type path with the full picker
await page.click('[data-testid=all-categories]')
await page.fill('[data-testid=category-search]', 'Lavand')
await page.click('[data-testid=picker-category]')
for (const k of ['1', '2']) await page.click(`[data-key="${k}"]`)
await page.click('[data-testid=save-button]')
await page.waitForSelector('[data-testid=toast]')
check('P2 picker + save button', (await text('[data-testid=toast]')).includes('Lavanderia'))
check('P2 count 1621', (await countTx()) === 1621)

// Persistence
await page.reload()
await page.waitForSelector('[data-testid=chips] [data-testid=chip]')
check('P2 chips after reload', (await page.$$('[data-testid=chips] [data-testid=chip]')).length === 8)

// ---------- Phase 3: list ----------
await page.click('[data-testid=tab-list]')
await page.waitForSelector('[data-testid=list-screen]')
await page.click('[data-testid=period-all]')
await page.waitForFunction(() => document.querySelector('[data-testid=list-count]')?.textContent?.startsWith('1621'))
check('P3 list shows all rows', true)
await page.fill('[data-testid=list-search]', 'abacaxi')
await page.waitForFunction(() => document.querySelector('[data-testid=list-count]')?.textContent?.startsWith('1 '))
const rowText = await text('[data-testid=tx-row]')
check('P3 search finds the pineapple', rowText.includes('Abacaxi') && rowText.includes('¥37,00'), rowText)
await shot('p3-list-search')

// Edit: change the amount and the note, then verify
await page.click('[data-testid=tx-row]')
await page.waitForSelector('[data-testid=edit-sheet]')
await page.fill('[data-testid=edit-amount]', '38,5')
await page.fill('[data-testid=edit-note]', 'Abacaxi editado')
await page.click('[data-testid=edit-save]')
await page.waitForSelector('[data-testid=edit-sheet]', { state: 'detached' })
await page.fill('[data-testid=list-search]', 'editado')
await page.waitForFunction(() => document.querySelector('[data-testid=list-count]')?.textContent?.startsWith('1 '))
check('P3 edit persisted', (await text('[data-testid=tx-row]')).includes('¥38,50'))

// Category filter + month navigation
await page.fill('[data-testid=list-search]', '')
await page.click('[data-testid=period-month]')
await page.waitForSelector('[data-testid=month-label]')
check('P3 month view shows today\'s entries', Number((await text('[data-testid=list-count]')).split(' ')[0]) >= 3)

// Top-up label on Cantina rows (spec §3)
await page.click('[data-testid=filter-category]')
await page.fill('[data-testid=category-search]', 'Cantina')
await page.click('[data-testid=picker-category]')
await page.click('[data-testid=period-all]')
await page.waitForFunction(() => document.querySelector('[data-testid=list-count]')?.textContent?.startsWith('145'))
check('P3 Cantina rows labelled top-up', (await text('[data-testid=tx-row]')).toLowerCase().includes('top-up'))
await page.click('[data-testid=filter-clear]')

await page.click('[data-testid=filter-category]')
await page.fill('[data-testid=category-search]', 'Táxi')
await page.click('[data-testid=picker-category]')
await page.waitForFunction(() => document.querySelector('[data-testid=list-count]')?.textContent?.startsWith('149'))
check('P3 category filter → 149 Táxi rows', true)
await shot('p3-list-filter')

// Delete with undo
await page.click('[data-testid=tx-row]')
await page.waitForSelector('[data-testid=edit-sheet]')
await page.click('[data-testid=edit-delete]')
await page.click('[data-testid=edit-delete]')
await page.waitForSelector('[data-testid=edit-sheet]', { state: 'detached' })
await page.waitForFunction(() => document.querySelector('[data-testid=list-count]')?.textContent?.startsWith('148'))
await page.click('[data-testid=toast-action]')
await page.waitForFunction(() => document.querySelector('[data-testid=list-count]')?.textContent?.startsWith('149'))
check('P3 delete + undo', true)
await page.click('[data-testid=tx-row]')
await page.click('[data-testid=edit-delete]')
await page.click('[data-testid=edit-delete]')
await page.waitForFunction(() => document.querySelector('[data-testid=list-count]')?.textContent?.startsWith('148'))
check('P3 delete sticks', (await countTx()) === 1620)

// ---------- Phase 4: insights ----------
await page.click('[data-testid=tab-insights]')
await page.waitForSelector('[data-testid=insights-screen]')
await page.click('[data-testid=ins-period-all]')
await page.waitForSelector('[data-testid=donut] path')
check('P4 donut has slices', (await page.$$('[data-testid=donut] path')).length >= 7)
check('P4 monthly columns rendered', (await page.$$('[data-testid=monthly-columns] svg g')).length >= 30)
check('P4 heatmap 168 cells', (await page.$$('[data-testid=heatmap] rect')).length === 168)
check('P4 ranked bars', (await page.$$('[data-testid=ranked-bars] li')).length >= 8)
check('P4 drift rows', (await page.$$('[data-testid=drift] li')).length >= 3)
const insTotal = await text('[data-testid=ins-total]')
check('P4 hero total in ref currency', insTotal.startsWith('¥9'), insTotal)
// tap a column → tooltip
const col = (await page.$$('[data-testid=monthly-columns] svg g'))[12]
await col.dispatchEvent('pointerdown')
check('P4 column tooltip', (await text('[data-testid=monthly-tooltip]')).includes('lanç'), await text('[data-testid=monthly-tooltip]'))
// Coverage — two flavours (spec §8)
const summary = await text('[data-testid=untracked-summary]')
check('P4 declared gap listed (jan–abr 2025)', summary.includes('jan 25') && summary.includes('abr 25'), summary)
check('P4 monthly chart draws untracked months as gaps', (await page.$$('[data-testid=monthly-columns] svg line[stroke-dasharray="2 4"]')).length === 4)
await page.click('[data-testid=coverage-more]')
const emptyRun = await page.waitForSelector('[data-testid=declare-2023-06]')
check('P4 wholly empty months collapse into one run (jun→dez 23)', (await emptyRun.getAttribute('data-run-end')) === '2023-12')
const junRun = await page.$('[data-testid=declare-2024-06]')
const julRun = await page.$('[data-testid=declare-2024-07]')
check('P4 months holding transactions each stand alone', junRun !== null && julRun !== null && (await junRun.getAttribute('data-run-end')) === '2024-06' && (await julRun.getAttribute('data-run-end')) === '2024-07')
check('P4 no run reaches across a month that has data', (await page.$$eval('[data-testid=suspect-months] button[data-run-end]', (els) => els.every((e) => e.dataset.runEnd === e.dataset.testid.replace('declare-', '') || e.closest('li').textContent.includes('0 lanç.')))) === true)
check('P4 declared months are not offered', (await page.$('[data-testid=declare-2025-02]')) === null && (await page.$('[data-testid=declare-2025-01]')) === null)
await junRun.click()
await page.waitForSelector('[data-testid=declare-2024-06]', { state: 'detached' })
check('P4 one tap declares only that month', (await text('[data-testid=untracked-summary]')).includes('jun 24'))
check('P4 jul 24 is still offered, not swept along', (await page.$('[data-testid=declare-2024-07]')) !== null)
check('P4 chart now has 5 gaps', (await page.$$('[data-testid=monthly-columns] svg line[stroke-dasharray="2 4"]')).length === 5)
// Top-ups out of ticket stats / heatmap, in totals
const ticket = await text('[data-testid=ticket]')
check('P4 ticket stats exclude top-ups', ticket.includes('top-ups fora'), ticket)
check('P4 heatmap labelled sem top-ups', (await text('[data-testid=insights-screen]')).includes('sem top-ups'))
check('P4 ranked bars label top-up', (await text('[data-testid=ranked-bars]')).includes('Cantina · top-up'))
await shot('p4-insights')
// Balance check (spec §8.1): quiet with 0/1 checks, one number with two
check('P4 balance quiet with no checks', (await page.$('[data-testid=balance-quiet]')) !== null)
await page.click('[data-testid=balance-open]')
await page.waitForSelector('[data-testid=balance-sheet]')
await page.fill('[data-testid=balance-amount]', '2000')
await page.fill('[data-testid=balance-date]', '2026-04-01T10:00')
await page.click('[data-testid=balance-save]')
await page.waitForSelector('[data-testid=balance-list] li')
await page.click('[data-testid=sheet-close]')
check('P4 still quiet with one check', (await text('[data-testid=balance-quiet]')).includes('Uma conferência'))
await page.click('[data-testid=balance-open]')
await page.fill('[data-testid=balance-amount]', '500')
await page.fill('[data-testid=balance-date]', '2026-05-01T10:00')
await page.click('[data-testid=balance-save]')
await page.waitForFunction(() => document.querySelectorAll('[data-testid=balance-list] li').length === 2)
await page.click('[data-testid=sheet-close]')
await page.waitForSelector('[data-testid=capture-rate]')
const capture = await text('[data-testid=capture-rate]')
check('P4 capture rate from two checks', /\d+% capturado/.test(capture) || capture.includes('receita não registrada'), capture)
await shot('p4-balance')
await page.click('[data-testid=ins-period-month]')
await page.waitForTimeout(200)
check('P4 this-month period works', (await text('[data-testid=ins-total]')).length > 0)

// ---------- Phase 5: export ----------
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
await page.click('[data-testid=tab-export]')
await page.waitForSelector('[data-testid=export-screen]')
await page.click('[data-testid=exp-all]')
await page.waitForFunction(() => document.querySelector('[data-testid=exp-count]')?.textContent?.startsWith('1620'))
await page.click('[data-testid=exp-copy]')
await page.waitForSelector('[data-testid=exp-status]')
const clip = await page.evaluate(() => navigator.clipboard.readText())
check('P5 bundle copied to clipboard', clip.startsWith('# Gastos') && clip.includes('## 4. Transactions') && clip.includes('```csv'), `${clip.length} chars`)
const csvLines = clip.split('```csv\n')[1].split('\n```')[0].split('\n')
check('P5 bundle CSV has header + 1620 rows', csvLines.length === 1621, `${csvLines.length} lines; header: ${csvLines[0]}`)
check('P5 bundle flags incomplete months', clip.includes('**incomplete** months') && clip.includes('2023-06'))
check('P5 bundle separates untracked months', clip.includes('**untracked** months (2024-06, 2025-01, 2025-02, 2025-03, 2025-04)'), clip.split('\n').find((l) => l.startsWith('- Coverage')))
check('P5 bundle explains top-ups', clip.includes('**Top-up categories** (Cantina)'))
check('P5 bundle has no payment method', !clip.toLowerCase().includes('payment'))
await shot('p5-export')

const dl = page.waitForEvent('download')
await page.click('[data-testid=exp-share]')
const download = await dl
check('P5 .md download', download.suggestedFilename().endsWith('.md'), download.suggestedFilename())

const dlJson = page.waitForEvent('download')
await page.click('[data-testid=exp-json]')
const backupPath = await (await dlJson).path()
const backup = JSON.parse(readFileSync(backupPath, 'utf-8'))
check('P5 backup JSON complete (v2)', backup.format === 'gastos-backup' && backup.version === 2 && backup.transactions.length === 1620 && backup.categories.length === 41 && backup.untrackedPeriods.length === 2 && backup.balanceChecks.length === 2)

const dlCsv = page.waitForEvent('download')
await page.click('[data-testid=exp-csv]')
const csvPath = await (await dlCsv).path()
check('P5 full CSV', readFileSync(csvPath, 'utf-8').split('\n').length === 1621)

// Restore (merge) is a no-op on the same data
await page.setInputFiles('[data-testid=restore-input]', backupPath)
await page.waitForSelector('[data-testid=restore-pending]')
await page.click('[data-testid=restore-merge]')
await page.waitForSelector('[data-testid=restore-report]')
check('P5 merge restore is a no-op', (await text('[data-testid=restore-report]')).includes('0 transações adicionadas, 1620 já existiam'), await text('[data-testid=restore-report]'))

// ---------- Phase 6: PWA offline ----------
await page.click('[data-testid=tab-settings]')
await page.waitForSelector('[data-testid=pwa-card]')
await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated')
check('P6 service worker active', true)
check('P6 manifest linked', (await page.$('link[rel=manifest]')) !== null)
const manifestHref = await page.$eval('link[rel=manifest]', (l) => l.getAttribute('href'))
const manifest = await page.evaluate(async (href) => (await fetch(href)).json(), manifestHref)
check('P6 manifest start_url/scope match base', manifest.start_url === basePath && manifest.scope === basePath, `${manifest.start_url} ${manifest.scope}`)
check('P6 icons resolve', (await page.evaluate(async (m) => (await Promise.all(m.icons.map((i) => fetch(i.src).then((r) => r.ok)))).every(Boolean), manifest)) === true)
check('P6 no external hosts contacted', [...hosts].every((h) => h.startsWith('localhost')), [...hosts].join(', '))
await page.waitForTimeout(500) // let precache finish
await ctx.setOffline(true)
await page.reload({ waitUntil: 'load' })
await page.waitForSelector('[data-testid=tabbar]', { timeout: 15000 })
check('P6 settings render offline', (await text('[data-testid=pwa-offline]')).includes('pronto'), await text('[data-testid=pwa-offline]'))
await page.click('[data-testid=tab-entry]')
await page.waitForSelector('[data-testid=chips] [data-testid=chip]', { timeout: 15000 })
check('P6 app loads offline with data', (await page.$$('[data-testid=chips] [data-testid=chip]')).length === 8)
for (const k of ['7']) await page.click(`[data-key="${k}"]`)
await page.$('[data-testid=chips] [data-testid=chip]:has-text("Café")').then((c) => c.click())
await page.waitForSelector('[data-testid=toast]')
check('P6 can log offline', (await text('[data-testid=toast]')).includes('¥7,00'))
await page.click('[data-testid=tab-insights]')
await page.waitForSelector('[data-testid=insights-screen]')
check('P6 insights offline', (await page.$$('[data-testid=heatmap] rect')).length === 168)
await shot('p6-offline')
await ctx.setOffline(false)

// ---------- wrap ----------
check('no console/page errors', errors.length === 0, errors.join('\n'))
await browser.close()
server.close()
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
