// Fake chrome.tabs for one window, with Chrome move semantics and Arc-like failure modes:
//   'works'          normal Chrome behaviour
//   'ignores'        move() resolves but nothing changes (Arc's reported behaviour)
//   'throws'         move() rejects
//   'only-minus-one' only {index:-1} (append) works; other indexes are silently ignored
//   'only-array'     only array moves work; single-id moves are ignored
//   'hangs'          move() never settles
export function fakeTabs(spec, mode = 'works') {
  let tabs = spec.map((t, i) => ({
    id: t.id,
    pinned: !!t.pinned,
    title: t.title || `T${t.id}`,
    url: t.url || `https://h${t.id}.com/`,
    index: i,
  }));
  const listeners = new Set();
  const calls = [];
  const reindex = () =>
    tabs.forEach((t, i) => {
      t.index = i;
    });
  function moveOne(id, index) {
    const from = tabs.findIndex((t) => t.id === id);
    if (from < 0) throw new Error(`No tab with id: ${id}.`);
    const [tab] = tabs.splice(from, 1);
    const pinnedCount = tabs.filter((t) => t.pinned).length;
    let to = index === -1 ? tabs.length : Math.min(index, tabs.length);
    if (!tab.pinned) to = Math.max(to, pinnedCount);
    tabs.splice(to, 0, tab);
    reindex();
    if (to !== from) for (const l of listeners) l(id, { fromIndex: from, toIndex: to });
  }
  const api = {
    calls,
    async query() {
      return tabs.map((t) => ({ ...t }));
    },
    async get(id) {
      const t = tabs.find((x) => x.id === id);
      if (!t) throw new Error('no tab');
      return { ...t };
    },
    move(ids, { index }) {
      calls.push({ ids, index });
      if (mode === 'hangs') return new Promise(() => {});
      if (mode === 'throws') return Promise.reject(new Error('Tabs cannot be edited right now'));
      if (mode === 'ignores') return Promise.resolve({});
      if (mode === 'only-minus-one' && index !== -1) return Promise.resolve({});
      if (mode === 'only-array' && !Array.isArray(ids)) return Promise.resolve({});
      const list = Array.isArray(ids) ? ids : [ids];
      list.forEach((id, k) => moveOne(id, index === -1 ? -1 : index + k));
      return Promise.resolve({});
    },
    onMoved: { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) },
    sleep: async () => {},
    order: () => tabs.map((t) => t.id),
  };
  return api;
}
