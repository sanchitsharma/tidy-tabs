import '../test-support/no-network.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGroups, applyGroups, GROUP_COLORS } from '../lib/tab-groups.js';

const C = (label, ...tabIds) => ({ label, tabIds });

test('planGroups: create when nothing owned; singletons not grouped; colors cycle', () => {
  const { actions, ungroup } = planGroups([C('Code', 1, 2), C('Solo', 3), C('Mail', 4, 5)]);
  assert.deepEqual(
    actions.map((a) => [a.label, a.action, a.groupId, a.color]),
    [
      ['Code', 'create', null, GROUP_COLORS[0]],
      ['Mail', 'create', null, GROUP_COLORS[1]],
    ],
  );
  assert.deepEqual(ungroup, []);
});

test('planGroups: same title reused (case-insensitive), leftovers renamed, extra created', () => {
  const owned = [
    { id: 100, title: 'mail' },
    { id: 101, title: 'Old Topic' },
  ];
  const { actions } = planGroups([C('Code', 1, 2), C('Mail', 3, 4), C('Trip', 5, 6)], owned);
  assert.deepEqual(
    actions.map((a) => [a.label, a.action, a.groupId]),
    [
      ['Code', 'rename', 101],
      ['Mail', 'reuse', 100],
      ['Trip', 'create', null],
    ],
  );
});

test('planGroups: singleton sitting in an owned group gets ungrouped; foreign groups untouched', () => {
  const tabGroupOf = new Map([
    [3, 100],
    [7, 555],
  ]);
  const { ungroup } = planGroups([C('Code', 1, 2), C('Solo', 3), C('Other', 7)], [{ id: 100, title: 'X' }], tabGroupOf);
  assert.deepEqual(ungroup, [3]);
});

// Fake chrome.tabs.group / tabGroups with Chrome semantics.
function fakeGroupsApi({ hang = false } = {}) {
  const groups = new Map(); // id -> {id,title,color,collapsed}
  const member = new Map(); // tabId -> groupId
  let next = 1;
  const prune = () => {
    for (const id of groups.keys()) if (![...member.values()].includes(id)) groups.delete(id);
  };
  return {
    groups,
    member,
    queryGroups: async () => [...groups.values()].map((g) => ({ ...g })),
    group: async ({ tabIds, groupId }) => {
      if (hang) return new Promise(() => {});
      const id = groupId ?? next++;
      if (!groups.has(id)) groups.set(id, { id, title: '', color: 'grey', collapsed: false });
      for (const t of tabIds) member.set(t, id);
      prune();
      return id;
    },
    update: async (id, props) => {
      Object.assign(groups.get(id), props);
    },
    ungroup: async (ids) => {
      for (const t of ids) member.delete(t);
      prune();
    },
    tabs: (ids) => ids.map((id) => ({ id, groupId: member.get(id) ?? -1 })),
  };
}

test('applyGroups: first run creates named groups; re-tidy reuses/renames, no duplicates', async () => {
  const api = fakeGroupsApi();
  const ids = [1, 2, 3, 4, 5, 6];
  const r1 = await applyGroups({
    windowId: 9,
    clusters: [C('Code', 1, 2), C('Mail', 3, 4), C('Trip', 5, 6)],
    tabs: api.tabs(ids),
    api,
  });
  assert.deepEqual([r1.created, r1.reused, r1.renamed, r1.errors], [3, 0, 0, []]);
  assert.deepEqual(
    [...api.groups.values()].map((g) => g.title),
    ['Code', 'Mail', 'Trip'],
  );
  assert.ok([...api.groups.values()].every((g) => g.collapsed === false));

  // Re-tidy with different clusters: Mail kept, Code group renamed to Docs, Trip's tabs merged away.
  const r2 = await applyGroups({
    windowId: 9,
    clusters: [C('Docs', 1, 2, 5), C('Mail', 3, 4, 6)],
    tabs: api.tabs(ids),
    ownedIds: r1.ownedIds,
    api,
  });
  assert.deepEqual([r2.created, r2.reused, r2.renamed], [0, 1, 1]);
  assert.equal(api.groups.size, 2, 'no duplicate groups left behind');
  assert.deepEqual([...api.groups.values()].map((g) => g.title).sort(), ['Docs', 'Mail']);
  assert.equal(new Set(r2.ownedIds).size, 2);
});

test('applyGroups: collapse option, user groups not treated as owned', async () => {
  const api = fakeGroupsApi();
  await api.group({ tabIds: [9, 10] }); // user's own group (id 1)
  await api.update(1, { title: 'Code' });
  const r = await applyGroups({
    windowId: 1,
    clusters: [C('Code', 1, 2), C('Mail', 3, 4)],
    tabs: api.tabs([1, 2, 3, 4]),
    ownedIds: [],
    collapsed: true,
    api,
  });
  assert.equal(r.created, 2, 'same-titled user group is not hijacked');
  assert.equal(api.groups.size, 3);
  assert.ok([...api.groups.values()].filter((g) => g.id !== 1).every((g) => g.collapsed === true));
});

test('applyGroups: hanging API times out, stops, reports', async () => {
  const api = fakeGroupsApi({ hang: true });
  const t0 = Date.now();
  const r = await applyGroups({
    windowId: 1,
    clusters: [C('A', 1, 2), C('B', 3, 4)],
    tabs: api.tabs([1, 2, 3, 4]),
    api,
  });
  assert.equal(r.created, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /did not settle/);
  assert.ok(Date.now() - t0 < 3000);
});
