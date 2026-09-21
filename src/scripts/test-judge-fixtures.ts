// src/scripts/test-judge-fixtures.ts
// Live-Regressionslauf gegen das echte Prüfmodell (kostet Geld, daher nicht in `npm test`).
// Aufruf: npm run test:judge — Pflicht vor jeder Änderung an judge-prompt.ts.
import { readFileSync } from 'node:fs';
import { judgeDraft } from '../services/auto-send/judge-service.js';
import { decide } from '../services/auto-send/policy.js';
import type { SupportedLanguage } from '../utils/language-detect.js';

// #695: dieses Skript testet NUR die Judge-Schicht (Live-Aufruf gegen das Prüfmodell) — es
// generiert selbst keine Entwürfe und durchläuft weder den mechanischen Check noch den
// Neuversuch-Pfad aus generate-drafts.ts (die sind in draft-service.test.ts,
// mechanical-checks.test.ts, runner.test.ts und generate-drafts.test.ts abgedeckt). Optionales
// `guestLanguage` je Fixture testet, dass der neue Judge-Kontext-Fakt (Spec Punkt 1) korrekt
// durchgereicht wird, ohne dass ein sprachlich passender Entwurf fälschlich als riskant gilt.
interface Case {
  name: string; guestMessages: string[]; draft: string; facts?: string; guestName?: string | null;
  guestLanguage?: SupportedLanguage; expected: { category: string; auto: boolean };
}
const cases = JSON.parse(readFileSync(new URL('../test-fixtures/judge/cases.json', import.meta.url), 'utf8')) as Case[];
let failed = 0;
for (const c of cases) {
  const r = await judgeDraft({
    guestMessages: c.guestMessages, draft: c.draft, voice: 'Du, locker, herzlich, kurz.',
    facts: c.facts ?? '(keine Fakten)', bookingContext: null, guestName: c.guestName ?? null,
    guestLanguage: c.guestLanguage,
  });
  if (r.kind !== 'verdict') { console.log(`✗ ${c.name}: technisch fehlgeschlagen (${r.error})`); failed++; continue; }
  const v = r.verdict;
  const d = decide({ mode: 'live', paused: false, judge: r, mechanical: [], threadHasHumanIntervention: false, threadHasFailedSend: false, autoSentToday: 0, dailyCap: 10, canSend: true });
  const wouldAuto = d.decision === 'auto';
  const ok = v.category === c.expected.category && wouldAuto === c.expected.auto;
  console.log(`${ok ? '✓' : '✗'} ${c.name}: ${v.category} auto=${wouldAuto} flags=[${v.riskFlags.join(',')}] conf=${v.confidence} — ${v.reasoning} — ${d.reason}`);
  if (!ok) failed++;
}
console.log(`\n${cases.length - failed}/${cases.length} Fälle wie erwartet`);
process.exit(failed ? 1 : 0);
