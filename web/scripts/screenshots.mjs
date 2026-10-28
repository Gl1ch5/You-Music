// Renders the built UI with the mock bridge in headless Chromium and saves phone-sized screenshots to docs/screenshots.
// Usage: npm run build && npm run screenshots
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { preview } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../docs/screenshots');
await mkdir(out, { recursive: true });

const server = await preview({ root: path.resolve(here, '..'), preview: { port: 4173, strictPort: true }, logLevel: 'error' });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 868 }, deviceScaleFactor: 2.7, hasTouch: true, colorScheme: 'dark' });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const wait = (ms) => page.waitForTimeout(ms);
const shot = async (name) => {
  await wait(700);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log('saved', name);
};
const tab = (label) => page.click(`.tab[aria-label="${label}"]`);
const back = () => page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

await page.goto('http://localhost:4173/index.html');
await page.waitForSelector('.stream-row');
await shot('01-home');

await page.click('.stream-row button');
await wait(800);
await shot('02-home-playing');

await page.click('.mini');
await wait(900);
await shot('03-player');

await page.click('.player-actions .action:nth-child(1)');
await shot('04-queue');
await back();
await wait(400);
await page.click('.player-actions .action:nth-child(2)');
await wait(2500);
await shot('05-lyrics');
await back();
await wait(400);
await page.click('.player-head .btn-icon');
await wait(600);

await tab('Поиск');
await page.fill('.field input', 'n');
await page.keyboard.press('Enter');
await wait(600);
await shot('06-search');
await page.evaluate(() => document.querySelector('.screen[data-route="search"]').scrollBy(0, 420));
await shot('06b-search-playlists');

await tab('Коллекция');
await shot('07-collection');
await page.click('text=Мне нравится');
await shot('08-likes');
await back();
await page.click('.tile:has-text("Плейлисты")');
await wait(300);
await page.click('.row:has-text("Отборные биточки")');
await shot('09-playlist');
await back();
await back();
await page.click('.tile:has-text("Скачанное")');
await shot('10-downloads');
await back();

await tab('Главная');
await page.click('.page-head .btn-icon');
await shot('11-settings');
await page.click('.item:has(.item-main > div:text-is("Прокси"))');
await shot('15-proxy');
await back();
await wait(500);
await page.click('.item:has-text("Обновления")');
await shot('16-updates');
await back();
await page.click('.item:has-text("Иконка приложения")');
await wait(300);
await shot('17-app-icon');
await back();
await wait(400);
await page.click('text=Редактор тем');
await shot('12-theme-editor');
await back();
await wait(400);
await page.click('text=Тема');
await page.click('.sheet .item:has-text("Paper")');
await back();
await wait(400);
await tab('Коллекция');
await shot('13-paper-collection');
await page.click('.mini');
await wait(900);
await shot('14-paper-player');

await browser.close();
await server.close();
if (errors.length) {
  console.error('Page errors:\n' + errors.join('\n'));
  process.exit(1);
}
