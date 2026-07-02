import { describe, it, expect, vi } from 'vitest';
import { generateSuggestion } from './suggestion-service.js';

describe('generateSuggestion', () => {
  it('feeds note + draft + file content to the model and returns the proposal', async () => {
    const call = vi.fn().mockResolvedValue({
      target_heading: '## Anti-Pattern', addition_text: '- Nicht ungefragt andere Objekte anbieten', rationale: 'Gastfrage war nur zur Schilderwerkstatt',
    });
    const out = await generateSuggestion(
      { category: 'ton', note: 'erwähnt ungefragt das Bootshaus', draftBody: 'Hey Michael, ... am Bootshaus ...', fileContent: '# Voice\n## Anti-Pattern\n- alt' },
      { call },
    );
    expect(out?.target_heading).toBe('## Anti-Pattern');
    expect(out?.addition_text).toContain('Nicht ungefragt');
    const arg = call.mock.calls[0][0];
    expect(arg.userMessage).toContain('erwähnt ungefragt das Bootshaus');
    expect(arg.userMessage).toContain('am Bootshaus');
    expect(arg.userMessage).toContain('## Anti-Pattern'); // file content included
  });

  it('returns null on an empty/malformed proposal', async () => {
    const call = vi.fn().mockResolvedValue({ target_heading: '', addition_text: '', rationale: '' });
    expect(await generateSuggestion({ category: 'ton', note: 'x', draftBody: 'y', fileContent: 'z' }, { call })).toBeNull();
  });
});
