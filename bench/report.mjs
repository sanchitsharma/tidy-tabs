// Print the comparison table (median of 3, cold run 1 in parentheses) from runs/*.json.
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('./runs/', import.meta.url);
const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const f = (x, d = 2) => (x == null ? '–' : typeof x === 'number' ? (Number.isInteger(x) ? String(x) : x.toFixed(d)) : String(x));
const rows = [];
for (const file of readdirSync(dir).sort()) {
  const d = JSON.parse(readFileSync(new URL(file, dir)));
  const R = d.runs;
  const col = (fn, dp) => `${f(med(R.map(fn)), dp)} (${f(fn(R[0]), dp)})`;
  const brk = (r) => (r.timing?.embed_s != null
    ? `embed ${r.timing.embed_s.toFixed(1)} (load ${r.timing.embed_load_s.toFixed(1)}) + name ${r.timing.name_s.toFixed(1)} (load ${r.timing.name_load_s.toFixed(1)})`
    : r.timing?.apiMs != null ? `api ${(r.timing.apiMs / 1000).toFixed(1)} + CLI ${((r.timing.totalMs - r.timing.apiMs) / 1000).toFixed(1)}` : '');
  const mid = [...R].sort((a, b) => a.wallMs - b.wallMs)[1] || R[0];
  rows.push(`| ${d.backend}${d.tag ? ` ${d.tag}` : ''} | ${d.dataset} | ${R.filter((r) => r.metrics.valid).length}/${R.length} | ${col((r) => r.metrics.purity)} | ${col((r) => r.metrics.cohesion)} | ${col((r) => r.metrics.groupCount)} | ${col((r) => r.metrics.singletons)} | ${col((r) => r.wallMs / 1000, 1)} | ${brk(mid)} |`);
}
console.log('| Backend | Dataset | Valid | Purity | Cohesion | Groups | 1-tab groups | Wall s | Breakdown (median run) |');
console.log('|---|---|---|---|---|---|---|---|---|');
console.log(rows.join('\n'));
