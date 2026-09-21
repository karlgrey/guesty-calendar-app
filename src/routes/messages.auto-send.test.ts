import { describe, it, expect } from 'vitest';
import { renderAutoBadge, parseAutoFlags } from './messages.js';
import type { MessageDraft } from '../types/messages.js';

const d = (o: Partial<MessageDraft>): MessageDraft => ({ id: 'x', thread_id: 't', provider: 'hostex', body: '', status: 'pending', generated_by: 'llm', send_attempts: 0, external_message_id: null, error: null, created_at: '', sent_at: null, model: null, auto_decision: null, auto_category: null, auto_flags: null, auto_reason: null, auto_mode: null, auto_judged_at: null, sent_by: null, sent_body_changed: null, smarttasks_task_id: null, smarttasks_task_guest_message_id: null, request_kind: null, platform_deadline_at: null, ...o });

describe('renderAutoBadge', () => {
  it('ohne Entscheidung → leer', () => expect(renderAutoBadge(d({}))).toBe(''));
  it('automatisch gesendet → grün mit Uhrzeit', () => expect(renderAutoBadge(d({ status: 'sent', sent_by: 'auto', sent_at: '2026-09-19 13:05:00' }))).toContain('automatisch gesendet 13:05'));
  it('wait → gelb mit Grund', () => expect(renderAutoBadge(d({ auto_decision: 'wait', auto_reason: 'Kategorie Geld — nie automatisch' }))).toContain('wartet auf dich: Kategorie Geld'));
  it('shadow + auto → weiß „wäre automatisch"', () => expect(renderAutoBadge(d({ auto_decision: 'auto', auto_mode: 'shadow' }))).toContain('wäre automatisch gesendet worden'));
  it('escaped HTML im Grund', () => expect(renderAutoBadge(d({ auto_decision: 'wait', auto_reason: '<b>' }))).toContain('&lt;b&gt;'));

  // #696: Zusagen-Task-Nummer an den Erfolgs-Badges
  it('automatisch gesendet + Zusagen-Task → Task-Nummer im Badge', () => {
    const badge = renderAutoBadge(d({ status: 'sent', sent_by: 'auto', sent_at: '2026-09-19 13:05:00', smarttasks_task_id: 742 }));
    expect(badge).toContain('Task #742');
  });
  it('shadow + auto + Zusagen-Task → Task-Nummer im Badge', () => {
    expect(renderAutoBadge(d({ auto_decision: 'auto', auto_mode: 'shadow', smarttasks_task_id: 5 }))).toContain('Task #5');
  });
  it('live + auto + pending (Auto-Send steht aus) + Zusagen-Task → Task-Nummer im Badge', () => {
    expect(renderAutoBadge(d({ auto_decision: 'auto', auto_mode: 'live', status: 'pending', smarttasks_task_id: 6 }))).toContain('Task #6');
  });
  it('ohne Zusagen-Task keine Task-Erwähnung', () => {
    expect(renderAutoBadge(d({ status: 'sent', sent_by: 'auto', sent_at: '2026-09-19 13:05:00' }))).not.toContain('Task #');
  });

  // #697: Buchungsanfrage-Frist zusätzlich zur Task-Nummer im Badge
  it('automatisch gesendet + Buchungsanfrage-Task + Frist → Task-Nummer UND Frist im Badge', () => {
    const badge = renderAutoBadge(d({
      status: 'sent', sent_by: 'auto', sent_at: '2026-09-19 13:05:00',
      smarttasks_task_id: 701, platform_deadline_at: '2026-09-22T20:35:04.000Z',
    }));
    expect(badge).toContain('Task #701');
    expect(badge).toContain('Frist Di 22:35');
  });
  it('shadow + auto + Buchungsanfrage-Task + Frist → Frist im Badge', () => {
    const badge = renderAutoBadge(d({ auto_decision: 'auto', auto_mode: 'shadow', smarttasks_task_id: 701, platform_deadline_at: '2026-09-22T20:35:04.000Z' }));
    expect(badge).toContain('Frist Di 22:35');
  });
  it('ohne Frist keine Frist-Erwähnung', () => {
    expect(renderAutoBadge(d({ status: 'sent', sent_by: 'auto', sent_at: '2026-09-19 13:05:00', smarttasks_task_id: 742 }))).not.toContain('Frist');
  });
});

// #686 Nachzieh-Liste: JSON.parse(auto_flags) in der Thread-Ansicht darf bei kaputtem/fremdem
// Inhalt nicht die ganze Seite crashen (500) — robustes Parsen mit Fallback [].
describe('parseAutoFlags', () => {
  it('gültiges JSON-Array → Array', () => expect(parseAutoFlags('["digits","url"]')).toEqual(['digits', 'url']));
  it('null → leeres Array', () => expect(parseAutoFlags(null)).toEqual([]));
  it('undefined → leeres Array', () => expect(parseAutoFlags(undefined)).toEqual([]));
  it('leerer String → leeres Array', () => expect(parseAutoFlags('')).toEqual([]));
  it('kaputtes JSON → leeres Array statt Exception', () => expect(parseAutoFlags('{invalid')).toEqual([]));
  it('valides JSON, aber kein Array (z. B. Objekt) → leeres Array', () => expect(parseAutoFlags('{"a":1}')).toEqual([]));
});
