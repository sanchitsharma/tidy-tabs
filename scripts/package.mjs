// Build release artifacts into dist/:
//   tidy-tabs-ai-<version>.zip  the Chrome Web Store upload (extension/ minus tests and dev files;
//                               no "key": the store keeps the item's own key and ID)
//   native-host.tar.gz          the helper, downloaded by the one-line installer
//   install.sh, uninstall.sh    the installers, served from the GitHub release
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const STAGE = join(DIST, 'stage');
const EXCLUDE = new Set(['test', 'test-support', 'package.json', 'README.md', 'node_modules']);

rmSync(DIST, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

const manifest = JSON.parse(readFileSync(join(ROOT, 'extension/manifest.json'), 'utf8'));
cpSync(join(ROOT, 'extension'), join(STAGE, 'extension'), {
  recursive: true,
  filter: (src) => !EXCLUDE.has(src.split('/').at(-1)),
});
const storeManifest = { ...manifest };
delete storeManifest.key;
writeFileSync(join(STAGE, 'extension/manifest.json'), JSON.stringify(storeManifest, null, 2) + '\n');

const zip = join(DIST, `tidy-tabs-ai-${manifest.version}.zip`);
execFileSync('python3', [
  '-c',
  'import shutil,sys; shutil.make_archive(sys.argv[1], "zip", sys.argv[2])',
  zip.slice(0, -4),
  join(STAGE, 'extension'),
]);

const HOST_FILES = ['host.js', 'claude.js', 'framing.js', 'logfile.js', 'package.json', 'extension-id.js'];
execFileSync('tar', [
  '-czf',
  join(DIST, 'native-host.tar.gz'),
  '-C',
  ROOT,
  ...HOST_FILES.map((f) => `native-host/${f}`),
]);
for (const f of ['install.sh', 'uninstall.sh']) cpSync(join(ROOT, f), join(DIST, f));
rmSync(STAGE, { recursive: true, force: true });

// Sanity checks on the store zip.
const listing = execFileSync('python3', [
  '-c',
  'import zipfile,sys; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))',
  zip,
]).toString();
const bad = listing.split('\n').filter((n) => /(^|\/)(test|test-support)\//.test(n) || n === 'package.json');
if (bad.length) throw new Error(`store zip contains dev files: ${bad.join(', ')}`);
const zipped = JSON.parse(
  execFileSync('python3', [
    '-c',
    'import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read("manifest.json").decode())',
    zip,
  ]).toString(),
);
if ('key' in zipped) throw new Error('store zip manifest still has "key"');
const install = readFileSync(join(DIST, 'install.sh'), 'utf8');
const storeId = /STORE_EXTENSION_ID="([^"]*)"/.exec(install)?.[1];
console.log(`built ${zip} (${listing.trim().split('\n').length} files, version ${manifest.version})`);
console.log(`built ${join(DIST, 'native-host.tar.gz')}, install.sh, uninstall.sh`);
if (!/^[a-p]{32}$/.test(storeId || ''))
  console.warn(`warning: install.sh STORE_EXTENSION_ID is not set yet (${storeId})`);
