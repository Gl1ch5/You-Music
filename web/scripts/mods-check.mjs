// Smoke test for the mod system: loads examples/mods into the mock build, enables them and exercises their UI.
// Usage: npm run build && node scripts/mods-check.mjs
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { preview } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const examples = path.resolve(here, '../../examples/mods');
const ids = ['sleep-timer', 'clean-versions'];
const mods = await Promise.all(
  ids.map(async (id) => ({ id, baseUrl: `http://localhost:4174/mods/${id}/`, manifest: JSON.parse(await readFile(path.join(examples, id, 'manifest.json'), 'utf8')) })),
);

const server = await preview({ root: path.resolve(here, '..'), preview: { port: 4174, strictPort: true }, logLevel: 'error' });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 868 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/mods/**', async (route) => {
  const rel = new URL(route.request().url()).pathname.replace('/mods/', '');
  const body = await readFile(path.join(examples, rel), 'utf8');
  await route.fulfill({ body, contentType: rel.endsWith('.css') ? 'text/css' : 'text/javascript' });
});
await page.addInitScript((m) => (window.__mockMods = m), mods);
await page.goto('http://localhost:4174/index.html');
await page.waitForSelector('.reco-hero');
await page.click('.page-head .btn-icon');
await page.click('.item:has-text("Моды")');
await page.waitForSelector('.page-head h1:has-text("Моды")');
for (let i = 0; i < ids.length; i++) {
  await page.locator('.screen[data-route="mods"] .switch').nth(i).click();
  await page.waitForTimeout(400);
  await page.click('.sheet .btn.primary');
  await page.waitForTimeout(500);
}
await page.waitForTimeout(500);
const states = await page.$$eval('.screen[data-route="mods"] .switch', (els) => els.map((e) => e.classList.contains('on')));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.click('.reco-hero .play-btn');
await page.waitForTimeout(600);
await page.click('.mini');
await page.waitForTimeout(800);
const modButton = await page.$('.player-pills .player-pill[aria-label="Таймер сна"]');
if (!modButton) errors.push('sleep-timer button missing');
else {
  await modButton.click();
  await page.waitForTimeout(500);
  await page.click('.sheet .item:has-text("15 минут")');
}
const toasts = await page.$$eval('.toast', (els) => els.map((e) => e.textContent));
console.log('switches on:', states, 'toasts:', toasts);
await browser.close();
await server.close();
if (errors.length || !states.every(Boolean)) {
  console.error('FAILED', errors);
  process.exit(1);
}
console.log('mods ok');
