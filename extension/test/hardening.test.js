import '../test-support/no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { capGroups, repairGroups, groupByDomain, LABEL_MAX, MAX_GROUPS } from '../lib/core.js';
import { assignmentsToGroups, normalizeLabels } from '../lib/two-pass.js';
import { redactRecord, pushRecent } from '../lib/diagnostics.js';
import { DEFAULT_ENDPOINT } from '../lib/ollama-request.js';
import { DEFAULTS } from '../lib/settings.js';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));

test('manifest: localhost-only host permissions, optional for custom endpoints, no incognito', () => {
  assert.deepEqual(manifest.host_permissions, ['http://localhost:11434/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.equal(manifest.incognito, 'not_allowed');
  assert.equal(DEFAULT_ENDPOINT, 'http://localhost:11434');
  assert.equal(DEFAULTS.debugLogging, false);
});

test('capGroups: labels <= 40 chars, at most 8 groups, smallest overflow into Other', () => {
  const groups = Array.from({ length: 10 }, (_, i) => ({
    label: `G${i}`,
    tabIds: Array.from({ length: 10 - i }, (_, k) => i * 100 + k),
  }));
  groups[0].label = 'x'.repeat(100);
  const out = capGroups(groups);
  assert.equal(out.length, MAX_GROUPS);
  assert.equal(out[0].label.length, LABEL_MAX);
  assert.equal(out.at(-1).label, 'Other');
  assert.deepEqual(out.at(-1).tabIds, [...groups[7].tabIds, ...groups[8].tabIds, ...groups[9].tabIds]);
  assert.equal(out.flatMap((g) => g.tabIds).length, groups.flatMap((g) => g.tabIds).length);
  assert.deepEqual(capGroups([{ label: 'A', tabIds: [1] }]), [{ label: 'A', tabIds: [1] }]);
});

test('every repair path is capped (single-pass, two-pass, domain fallback)', () => {
  const n = 24;
  const idMap = Array.from({ length: n }, (_, i) => 1000 + i);
  const single = repairGroups(
    { groups: Array.from({ length: 12 }, (_, i) => ({ label: `Label ${i} `.repeat(8), tabIds: [2 * i, 2 * i + 1] })) },
    idMap,
  );
  assert.ok(single.groups.length <= MAX_GROUPS);
  assert.ok(single.groups.every((g) => g.label.length <= LABEL_MAX));
  const labels = Array.from({ length: 12 }, (_, i) => `L${i}`);
  const two = assignmentsToGroups(
    { assignments: idMap.map((_, i) => ({ id: i, group: labels[i >> 1] })) },
    labels,
    idMap,
  );
  assert.ok(two.groups.length <= MAX_GROUPS);
  assert.equal(
    normalizeLabels({ labels: ['Supercalifragilisticexpialidocious-and-more-and-more extra words'] })[0].length <=
      LABEL_MAX,
    true,
  );
  const tabs = Array.from({ length: 24 }, (_, i) => ({ id: i, url: `https://site${i >> 1}.com/` }));
  assert.ok(groupByDomain(tabs).length <= MAX_GROUPS);
});

test('redactRecord: no titles/hosts unless debug; errors, labels, sizes, moves kept', () => {
  const rec = {
    status: 'moves-failed',
    errors: [{ where: 'move', message: 'boom' }],
    counts: { total: 3 },
    before: [{ id: 1, title: 'Secret doc', host: 'private.example' }],
    groups: [
      {
        label: 'Work',
        tabs: [
          { id: 1, title: 'Secret doc', host: 'private.example' },
          { id: 2, title: 'x', host: 'y' },
        ],
      },
    ],
    moves: { verified: false, results: [{ name: 'batch-plan', threw: [{ error: 'boom' }] }] },
  };
  const r = redactRecord(rec, { debugLogging: false });
  const text = JSON.stringify(r);
  assert.ok(!text.includes('Secret doc') && !text.includes('private.example'));
  assert.deepEqual(r.groups, [{ label: 'Work', size: 2 }]);
  assert.deepEqual(r.errors, rec.errors);
  assert.deepEqual(r.moves, rec.moves);
  assert.ok(rec.before, 'original (in-memory, for the open popup) is not mutated');
  assert.equal(redactRecord(rec, { debugLogging: true }), rec);
  assert.equal(pushRecent([], r)[0].status, 'moves-failed');
});
