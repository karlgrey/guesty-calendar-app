// src/scripts/test-judge-fixtures.ts
// Live-Regressionslauf gegen das echte Prüfmodell (kostet Geld, daher nicht in `npm test`).
// Aufruf: npm run test:judge — Pflicht vor jeder Änderung an judge-prompt.ts.
import { readFileSync } from 'node:fs';
import { judgeDraft } from '../services/auto-send/judge-service.js';
import { runMechanicalChecks, collectDigitRuns } from '../services/auto-send/mechanical-checks.js';
import { decide, wouldAutoWithPromiseTask, wouldAutoWithBookingTask } from '../services/auto-send/policy.js';
import type { SupportedLanguage } from '../utils/language-detect.js';

// #695: dieses Skript testet NUR die Judge-Schicht (Live-Aufruf gegen das Prüfmodell) — es
// generiert selbst keine Entwürfe und durchläuft weder den mechanischen Check noch den
// Neuversuch-Pfad aus generate-drafts.ts (die sind in draft-service.test.ts,
// mechanical-checks.test.ts, runner.test.ts und generate-drafts.test.ts abgedeckt). Optionales
// `guestLanguage` je Fixture testet, dass der neue Judge-Kontext-Fakt (Spec Punkt 1) korrekt
// durchgereicht wird, ohne dass ein sprachlich passender Entwurf fälschlich als riskant gilt.
// #697: optionales `bookingContext` je Fixture spiegelt den BUCHUNGSKONTEXT-Block, den echte
// Buchungsanfragen im Judge-Prompt bekommen (booking-context.ts) — die mechanische
// System-Post-Erkennung (booking-request.ts) selbst läuft NICHT über dieses Skript (reiner
// Judge+Policy-Test, kein I/O), sondern ist in booking-request.test.ts/runner.test.ts abgedeckt.
// #698: optionales `now` (ISO) je Fixture — geht an judgeDraft (HEUTE-Fakt im Judge-Prompt) UND
// an die mechanischen Checks (Wochentags-Check). Ohne `now` bleibt beides wie bisher aus (die
// meisten Alt-Fixtures haben keine Zeitbezug-Erwartung und sollen nicht plötzlich vom
// tatsächlichen Live-now abhängen).
interface Case {
  name: string; guestMessages: string[]; draft: string; facts?: string; guestName?: string | null;
  guestLanguage?: SupportedLanguage; bookingContext?: string; now?: string;
  expected: {
    category: string | string[]; auto: boolean;
    // #696: optional — nur für Fälle mit Zusage gesetzt (Fixture "Lorenzo").
    riskFlags?: string[]; promisedActionContains?: string;
  };
}
const cases = JSON.parse(readFileSync(new URL('../test-fixtures/judge/cases.json', import.meta.url), 'utf8')) as Case[];
let failed = 0;
for (const c of cases) {
  const now = c.now ? new Date(c.now) : undefined;
  const r = await judgeDraft({
    guestMessages: c.guestMessages, draft: c.draft, voice: 'Du, locker, herzlich, kurz.',
    facts: c.facts ?? '(keine Fakten)', bookingContext: c.bookingContext ?? null, guestName: c.guestName ?? null,
    guestLanguage: c.guestLanguage, now,
  });
  if (r.kind !== 'verdict') { console.log(`✗ ${c.name}: technisch fehlgeschlagen (${r.error})`); failed++; continue; }
  const v = r.verdict;
  // #698 (Review): die Mechanik läuft jetzt für ALLE Fälle (wie live im Runner, runner.ts) statt
  // nur für buchungsanfrage — sonst würde eine Fixture „auto“ melden, die live an
  // zeitbezug_veraltet oder einem anderen mechanischen Check stoppt. isBookingRequest bleibt an
  // die Kategorie gekoppelt (confirmation_words ist nur dort relevant); now/bookingContext gehen
  // unconditional durch (ohne `now` läuft der Wochentags-Check ohnehin nicht, siehe oben).
  const mechanical = runMechanicalChecks(c.draft, {
    knownDigitRuns: collectDigitRuns([...c.guestMessages, c.bookingContext ?? '']),
    guestLanguage: c.guestLanguage,
    isBookingRequest: v.category === 'buchungsanfrage',
    now, bookingContext: c.bookingContext ?? null,
  });
  const baseInput = { mode: 'live' as const, paused: false, judge: r, mechanical, threadHasHumanIntervention: false, threadHasFailedSend: false, autoSentToday: 0, dailyCap: 10, canSend: true };
  const d = decide({ ...baseInput, promiseTask: null });
  // #696: ein Zusagen-Fall (promises_action allein) geht bei decide() nur "auto", wenn ein
  // Task bereits angelegt wurde — den simuliert hier niemand, deshalb zusätzlich über
  // wouldAutoWithPromiseTask prüfen, ob er es WÜRDE (kein SmartTasks-Aufruf nötig). #697:
  // spiegelbildlich für die Buchungsanfrage-Task-Anlage (wouldAutoWithBookingTask).
  const wouldAuto = d.decision === 'auto' || wouldAutoWithPromiseTask(baseInput) || wouldAutoWithBookingTask(baseInput);
  // expected.category darf eine Liste gleichwertiger (nie-automatischer) Kategorien sein — Fall
  // „erstattung = geld“ pendelt seit den #696/#697-Prompt-Ergänzungen zwischen geld/beschwerde_schaden.
  const expectedCategories = Array.isArray(c.expected.category) ? c.expected.category : [c.expected.category];
  let ok = expectedCategories.includes(v.category) && wouldAuto === c.expected.auto;
  if (c.expected.riskFlags) {
    ok = ok && JSON.stringify([...v.riskFlags].sort()) === JSON.stringify([...c.expected.riskFlags].sort());
  }
  if (c.expected.promisedActionContains) {
    ok = ok && !!v.promisedAction && v.promisedAction.toLowerCase().includes(c.expected.promisedActionContains.toLowerCase());
  }
  console.log(`${ok ? '✓' : '✗'} ${c.name}: ${v.category} auto=${wouldAuto} flags=[${v.riskFlags.join(',')}] mech=[${mechanical.map((m) => m.flag).join(',')}] promisedAction=${v.promisedAction ?? '–'} conf=${v.confidence} — ${v.reasoning} — ${d.reason}`);
  if (!ok) failed++;
}
console.log(`\n${cases.length - failed}/${cases.length} Fälle wie erwartet`);
process.exit(failed ? 1 : 0);
