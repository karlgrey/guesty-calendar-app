// src/scripts/test-judge-fixtures.ts
// Live-Regressionslauf gegen das echte Prüfmodell (kostet Geld, daher nicht in `npm test`).
// Aufruf: npm run test:judge — Pflicht vor jeder Änderung an judge-prompt.ts.
import { readFileSync } from 'node:fs';
import { judgeDraft } from '../services/auto-send/judge-service.js';
import { AUTO_OK_CATEGORIES } from '../services/auto-send/types.js';

interface Case { name: string; guestMessages: string[]; draft: string; facts?: string; guestName?: string | null; expected: { category: string; auto: boolean } }
const cases = JSON.parse(readFileSync(new URL('../test-fixtures/judge/cases.json', import.meta.url), 'utf8')) as Case[];
let failed = 0;
for (const c of cases) {
  const r = await judgeDraft({ guestMessages: c.guestMessages, draft: c.draft, voice: 'Du, locker, herzlich, kurz.', facts: c.facts ?? '(keine Fakten)', bookingContext: null, guestName: c.guestName ?? null });
  if (r.kind !== 'verdict') { console.log(`✗ ${c.name}: technisch fehlgeschlagen (${r.error})`); failed++; continue; }
  const v = r.verdict;
  const wouldAuto = AUTO_OK_CATEGORIES.has(v.category) && v.riskFlags.length === 0 && v.confidence === 'hoch' && (v.category !== 'playbook_fakt' || v.answerableFromFacts);
  const ok = v.category === c.expected.category && wouldAuto === c.expected.auto;
  console.log(`${ok ? '✓' : '✗'} ${c.name}: ${v.category} auto=${wouldAuto} flags=[${v.riskFlags.join(',')}] conf=${v.confidence} — ${v.reasoning}`);
  if (!ok) failed++;
}
console.log(`\n${cases.length - failed}/${cases.length} Fälle wie erwartet`);
process.exit(failed ? 1 : 0);
