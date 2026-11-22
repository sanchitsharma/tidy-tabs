#!/usr/bin/env node
// Stand-in for the Claude Code CLI in end-to-end tests. Records its argv, reads the tab list
// ("id|host|title" lines) from stdin, groups tabs by a keyword table, and prints the same JSON shape
// `claude -p --output-format json --json-schema …` does (structured_output).
import { appendFileSync, readFileSync } from 'node:fs';

const log = process.env.FAKE_CLAUDE_LOG;
if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\n');
const model = (process.argv.find((a) => a.startsWith('--model=')) || '--model=haiku').slice(8);

const input = readFileSync(0, 'utf8');
const TOPICS = [
  ['Python debugging', /python|stackoverflow|pypi/i],
  ['Trip to Lisbon', /lisbon|flight|hotel|booking/i],
];
const groups = TOPICS.map(([label]) => ({ label, tabIds: [] }));
const ungrouped = [];
for (const line of input.split('\n')) {
  const m = /^(\d+)\|([^|]*)\|(.*)$/.exec(line.trim());
  if (!m) continue;
  const id = Number(m[1]);
  const i = TOPICS.findIndex(([, re]) => re.test(`${m[2]} ${m[3]}`));
  if (i >= 0) groups[i].tabIds.push(id);
  else ungrouped.push(id);
}
process.stdout.write(
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    structured_output: { groups: groups.filter((g) => g.tabIds.length >= 2), ungrouped },
    modelUsage: { [`fake-${model}`]: {} },
    duration_ms: 5,
    duration_api_ms: 4,
    num_turns: 1,
  }),
);
