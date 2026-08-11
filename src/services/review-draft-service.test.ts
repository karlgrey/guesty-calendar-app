import { describe, it, expect, vi } from 'vitest';
import { generateReviewForStay } from './review-draft-service.js';

function baseInput(over: Partial<Parameters<typeof generateReviewForStay>[0]> = {}) {
  return {
    guestName: 'Darleen',
    propertyName: 'Bootshaus an der alten Oder',
    checkInLabel: '01.08.2026',
    checkOutLabel: '05.08.2026',
    nights: 4,
    voice: 'VOICE-X',
    threadHighlights: 'Gast: Hallo, können wir früh einchecken?\nHost: Klar, gerne!',
    ...over,
  };
}

describe('generateReviewForStay', () => {
  it('passes voice + stay context + thread highlights into the prompt and returns the review', async () => {
    const call = vi.fn().mockResolvedValue({ review: 'Darleen war ein unkomplizierter, freundlicher Gast.' });
    const out = await generateReviewForStay(baseInput(), { call });
    expect(out).toBe('Darleen war ein unkomplizierter, freundlicher Gast.');
    const arg = call.mock.calls[0][0];
    expect(arg.systemPrompt).toContain('VOICE-X');
    expect(arg.systemPrompt).toContain('bewertet den GAST');
    expect(arg.userMessage).toContain('Darleen');
    expect(arg.userMessage).toContain('Bootshaus an der alten Oder');
    expect(arg.userMessage).toContain('01.08.2026–05.08.2026');
    expect(arg.userMessage).toContain('4 Nächte');
    expect(arg.userMessage).toContain('Gast: Hallo, können wir früh einchecken?');
  });

  it('never invents property-condition claims — the rule is stated explicitly in the prompt', async () => {
    const call = vi.fn().mockResolvedValue({ review: 'x' });
    await generateReviewForStay(baseInput(), { call });
    const prompt = call.mock.calls[0][0].systemPrompt;
    expect(prompt).toMatch(/Erfinde NICHTS/);
    expect(prompt).toMatch(/Zustand der Unterkunft/);
  });

  it('states no-markdown / mirror-guest-language rules', async () => {
    const call = vi.fn().mockResolvedValue({ review: 'x' });
    await generateReviewForStay(baseInput(), { call });
    const prompt = call.mock.calls[0][0].systemPrompt;
    expect(prompt).toMatch(/Kein Markdown/);
    expect(prompt).toMatch(/spiegle die Sprache des Gastes/);
  });

  it('falls back to "kein Nachrichtenverlauf" wording when threadHighlights is empty', async () => {
    const call = vi.fn().mockResolvedValue({ review: 'x' });
    await generateReviewForStay(baseInput({ threadHighlights: '' }), { call });
    expect(call.mock.calls[0][0].userMessage).toContain('Kein Nachrichtenverlauf für diesen Aufenthalt vorhanden.');
  });

  it('handles an unknown guest name gracefully', async () => {
    const call = vi.fn().mockResolvedValue({ review: 'x' });
    await generateReviewForStay(baseInput({ guestName: null }), { call });
    expect(call.mock.calls[0][0].userMessage).toContain('Name unbekannt');
  });

  it('adds a hard problem-case rule to the prompt when flagged=true, and omits it otherwise', async () => {
    const call = vi.fn().mockResolvedValue({ review: 'x' });
    await generateReviewForStay(baseInput({ flagged: true }), { call });
    const flaggedPrompt = call.mock.calls[0][0].systemPrompt;
    expect(flaggedPrompt).toMatch(/HARTE REGEL/);
    expect(flaggedPrompt).toMatch(/Problemfall/);

    const call2 = vi.fn().mockResolvedValue({ review: 'x' });
    await generateReviewForStay(baseInput({ flagged: false }), { call: call2 });
    expect(call2.mock.calls[0][0].systemPrompt).not.toMatch(/HARTE REGEL/);

    const call3 = vi.fn().mockResolvedValue({ review: 'x' });
    await generateReviewForStay(baseInput(), { call: call3 }); // flagged omitted -> defaults to false
    expect(call3.mock.calls[0][0].systemPrompt).not.toMatch(/HARTE REGEL/);
  });

  it('returns null on an empty/malformed reply', async () => {
    const call = vi.fn().mockResolvedValue({ review: '   ' });
    expect(await generateReviewForStay(baseInput(), { call })).toBeNull();
    const call2 = vi.fn().mockResolvedValue({});
    expect(await generateReviewForStay(baseInput(), { call: call2 })).toBeNull();
  });
});
