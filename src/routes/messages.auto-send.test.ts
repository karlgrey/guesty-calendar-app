import { describe, it, expect } from 'vitest';
import { renderAutoBadge } from './messages.js';
import type { MessageDraft } from '../types/messages.js';

const d = (o: Partial<MessageDraft>): MessageDraft => ({ id: 'x', thread_id: 't', provider: 'hostex', body: '', status: 'pending', generated_by: 'llm', send_attempts: 0, external_message_id: null, error: null, created_at: '', sent_at: null, model: null, auto_decision: null, auto_category: null, auto_flags: null, auto_reason: null, auto_mode: null, auto_judged_at: null, sent_by: null, sent_body_changed: null, ...o });

describe('renderAutoBadge', () => {
  it('ohne Entscheidung → leer', () => expect(renderAutoBadge(d({}))).toBe(''));
  it('automatisch gesendet → grün mit Uhrzeit', () => expect(renderAutoBadge(d({ status: 'sent', sent_by: 'auto', sent_at: '2026-09-19 13:05:00' }))).toContain('automatisch gesendet 13:05'));
  it('wait → gelb mit Grund', () => expect(renderAutoBadge(d({ auto_decision: 'wait', auto_reason: 'Kategorie Geld — nie automatisch' }))).toContain('wartet auf dich: Kategorie Geld'));
  it('shadow + auto → weiß „wäre automatisch"', () => expect(renderAutoBadge(d({ auto_decision: 'auto', auto_mode: 'shadow' }))).toContain('wäre automatisch gesendet worden'));
  it('escaped HTML im Grund', () => expect(renderAutoBadge(d({ auto_decision: 'wait', auto_reason: '<b>' }))).toContain('&lt;b&gt;'));
});
