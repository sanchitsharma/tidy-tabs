// Renders store/assets.html into Chrome Web Store images (24-bit PNG, no alpha).
// Run: node store/capture-popup.mjs && node store/make-assets.mjs
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto('file://' + path.resolve('store/assets.html'));
await page.evaluate(() => document.fonts.ready);
const out = [];
for (const [id, name] of [
  ['shot1', 'screenshot-1-hero'],
  ['shot2', 'screenshot-2-popup'],
  ['shot3', 'screenshot-3-models-privacy'],
  ['tile', 'promo-small-440x280'],
]) {
  const file = `store/build/${name}.png`;
  await page.locator('#' + id).screenshot({ path: file });
  out.push(file);
}
await browser.close();
// flatten to RGB (the store rejects PNGs with an alpha channel)
execFileSync(
  'python3',
  [
    '-c',
    `
import sys
from PIL import Image
for f in sys.argv[1:]:
    im = Image.open(f).convert('RGB'); im.save(f); print(f, im.size, im.mode)
`,
    ...out,
  ],
  { stdio: 'inherit' },
);
