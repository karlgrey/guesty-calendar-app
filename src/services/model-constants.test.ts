import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/index.js', () => ({ config: { anthropicApiKey: 'test-key' } }));
vi.mock('../utils/logger.js', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { SONNET_MODEL } from './anthropic-client.js';
import { DRAFT_MODEL } from './draft-service.js';
import { REVIEW_MODEL } from './review-draft-service.js';

// #758: alle Sonnet-Aufrufe der App hängen an EINER Konstante (claude-sonnet-5-5).
describe('Modellkonstanten (#758)', () => {
  it('Entwurfs- und Bewertungsmodell sind Sonnet 5.5 aus der zentralen Konstante', () => {
    expect(SONNET_MODEL).toBe('claude-sonnet-5-5');
    expect(DRAFT_MODEL).toBe(SONNET_MODEL);
    expect(REVIEW_MODEL).toBe(SONNET_MODEL);
  });
});
