import { describe, it, expect } from 'vitest';
import { autoDecisionOutcome, autoDecisionTexts } from './decision-case.js';

const row = (o: Record<string, unknown>) => ({ status: 'pending', sent_by: null, sent_body_changed: null, body: 'Entwurf', ...o }) as any;

describe('autoDecisionOutcome', () => {
  it('sent + auto → auto_sent (auch wenn changed-Flag gesetzt)', () => {
    expect(autoDecisionOutcome(row({ status: 'sent', sent_by: 'auto', sent_body_changed: 1 }))).toBe('auto_sent');
  });
  it('sent + changed=1 → changed', () => {
    expect(autoDecisionOutcome(row({ status: 'sent', sent_by: 'micha', sent_body_changed: 1 }))).toBe('changed');
  });
  it('sent sonst → unchanged', () => {
    expect(autoDecisionOutcome(row({ status: 'sent', sent_by: 'micha', sent_body_changed: 0 }))).toBe('unchanged');
    expect(autoDecisionOutcome(row({ status: 'sent', sent_by: null, sent_body_changed: null }))).toBe('unchanged');
  });
  it('discarded / pending / sending / error → Status selbst', () => {
    for (const s of ['discarded', 'pending', 'sending', 'error']) expect(autoDecisionOutcome(row({ status: s }))).toBe(s);
  });
});

describe('autoDecisionTexts', () => {
  it('changed: Original überschrieben → draftText null, draftTextLost', () => {
    expect(autoDecisionTexts('changed', 'Gesendet')).toEqual({ draftText: null, sentText: 'Gesendet', draftTextLost: true });
  });
  it('unchanged / auto_sent: beide Texte = body', () => {
    for (const o of ['unchanged', 'auto_sent'] as const)
      expect(autoDecisionTexts(o, 'T')).toEqual({ draftText: 'T', sentText: 'T', draftTextLost: false });
  });
  it('discarded / pending / sending / error: nur draftText', () => {
    for (const o of ['discarded', 'pending', 'sending', 'error'] as const)
      expect(autoDecisionTexts(o, 'T')).toEqual({ draftText: 'T', sentText: null, draftTextLost: false });
  });
});
