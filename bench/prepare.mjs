// Normalize all datasets to bench/datasets/<name>.json = {name, tabs:[{id,title,url}], expected:{id:topic}|null}.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const F = new URL('./fixtures/', import.meta.url);
const OUT = new URL('./datasets/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const rd = (p) => JSON.parse(readFileSync(new URL(p, F)));
const save = (name, tabs, expected) => {
  writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify({ name, tabs, expected }, null, 1));
  const topics = expected ? Object.values(expected).reduce((m, t) => ({ ...m, [t]: (m[t] || 0) + 1 }), {}) : null;
  console.log(name, tabs.length, JSON.stringify(topics));
};
// VM fixtures carry `host` only: give them a URL so both backends see the same host+title.
const vmTabs = (arr) => arr.map((t) => ({ id: t.id, title: t.title, url: `https://${t.host}/` }));

// tabs-8 has no expected file upstream; labels are mine (3 GitHub PRs, 3 Vietnam trip, 2 YouTube music).
save('vm-8', vmTabs(rd('vm/tabs-8.json')), {
  0: 'github',
  1: 'github',
  2: 'github',
  3: 'vietnam',
  4: 'vietnam',
  5: 'vietnam',
  6: 'music',
  7: 'music',
});
save('vm-40', vmTabs(rd('vm/tabs-40.json')), rd('vm/expected-40.json'));
save('vm-120', vmTabs(rd('vm/tabs-120.json')), rd('vm/expected-120.json'));
save(
  'haiku-40',
  rd('haiku/tabs-40.json').map((t) => ({ id: t.id, title: t.title, url: t.url })),
  rd('haiku/expected-40.json'),
);

// sample-10: ten public browser-extension welcome/help pages plus one GitHub release.
const sample = [
  ['Page Edit (Design Mode) :: MyBrowserAddon', 'mybrowseraddon.com'],
  ['Chrome Issues | Authenticator', 'authenticator.cc'],
  ['octotree', 'octotree.io'],
  ['Install', 'adblock-for-y.com'],
  ['Release v0.15.0 · ruifigueira/playwright-crx · GitHub', 'github.com'],
  ['Volume Master - how to | Peta Sittek', 'petasittek.com'],
  ['Welcome - Unhook', 'unhook.app'],
  ['Sign up | Glasp', 'glasp.co'],
  ['Browser Extension Getting Started | Bitwarden', 'bitwarden.com'],
  ['Get Started with Buyhatke Extension | Buyhatke', 'buyhatke.com'],
];
save(
  'sample-10',
  sample.map(([title, host], i) => ({ id: 100 + i, title, url: `https://${host}/` })),
  null,
);

const messy = rd('messy-55.json');
save(
  'messy-55',
  messy.map(([url, title], i) => ({ id: 500 + i, title, url })),
  Object.fromEntries(messy.map(([, , topic], i) => [500 + i, topic])),
);
