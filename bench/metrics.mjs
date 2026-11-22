// Metrics shared by both backends. groups = [{label, tabIds}] in real tab ids; ds = {tabs, expected|null}.

/** valid: every input tab id appears exactly once and nothing else appears. */
export function validity(groups, tabs) {
  const ids = groups.flatMap((g) => g.tabIds);
  const want = new Set(tabs.map((t) => t.id));
  const seen = new Set(ids);
  return ids.length === want.size && seen.size === want.size && [...seen].every((id) => want.has(id));
}

/** Majority-topic accuracy over non-stray tabs (same as host-live.test.js / v2 common.py). */
export function purity(groups, expected) {
  let pure = 0,
    total = 0;
  for (const g of groups) {
    const topics = g.tabIds.map((id) => expected[String(id)]).filter((t) => t && t !== 'stray');
    total += topics.length;
    const c = {};
    for (const t of topics) c[t] = (c[t] || 0) + 1;
    pure += Math.max(0, ...Object.values(c));
  }
  return total ? +(pure / total).toFixed(3) : null;
}

/** Per non-stray topic, the share of its tabs in its largest group (inverse purity). */
export function cohesion(groups, expected) {
  const by = {};
  groups.forEach((g, gi) =>
    g.tabIds.forEach((id) => {
      const t = expected[String(id)];
      if (!t || t === 'stray') return;
      by[t] ??= {};
      by[t][gi] = (by[t][gi] || 0) + 1;
    }),
  );
  let best = 0,
    total = 0;
  for (const c of Object.values(by)) {
    best += Math.max(...Object.values(c));
    total += Object.values(c).reduce((a, b) => a + b, 0);
  }
  return total ? +(best / total).toFixed(3) : null;
}

export function metrics(groups, ds) {
  const exp = ds.expected;
  const describe = (g) => {
    const topics = exp ? [...new Set(g.tabIds.map((id) => exp[String(id)]))].join('/') : '';
    return `${g.label} (${g.tabIds.length}${topics ? `: ${topics}` : ''})`;
  };
  return {
    valid: validity(groups, ds.tabs),
    purity: exp ? purity(groups, exp) : null,
    cohesion: exp ? cohesion(groups, exp) : null,
    groupCount: groups.length,
    singletons: groups.filter((g) => g.tabIds.length === 1).length,
    names: groups.map(describe),
  };
}
