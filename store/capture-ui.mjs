// Capture the real popup (after a real tidy run with the e2e fake helper) and the real Options page at 2x,
// for the store screenshots. Run: node store/capture-ui.mjs
import { launch, openSites, tidyFromPopup } from '../tests/e2e/harness.mjs';

const b = await launch({ helper: 'fake', deviceScaleFactor: 2 });
try {
  await openSites(b.ctx);
  const popup = await tidyFromPopup(b.ctx, b.extId);
  await popup.setViewportSize({ width: 464, height: 900 });
  await popup.evaluate(() => {
    document.getElementById('progress').replaceChildren(); // keep the shot focused on the result
    document.getElementById('build-badge')?.remove();
  });
  const box = await popup.evaluate(() => {
    const r = document.querySelector('footer').getBoundingClientRect();
    return Math.ceil(r.bottom + 12);
  });
  const shot = (page, path, clip) => page.screenshot({ path, clip });
  await shot(popup, 'store/build/popup@2x.png', { x: 0, y: 0, width: 464, height: box });

  const options = await b.ctx.newPage();
  await options.goto(`chrome-extension://${b.extId}/options.html`);
  await options.selectOption('#claudeModelChoice', 'haiku');
  await options.evaluate(() => document.getElementById('build-badge')?.remove());
  const clip = await options.evaluate(() => {
    const b = document.body.getBoundingClientRect();
    const end = document.querySelector('h2').getBoundingClientRect().top;
    return { x: Math.max(0, b.left - 24), y: 0, width: b.width + 48, height: Math.ceil(end) - 8 };
  });
  await shot(options, 'store/build/options@2x.png', clip);
  console.log('captured popup and options');
} finally {
  await b.close();
}
