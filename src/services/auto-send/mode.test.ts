import { describe, it, expect } from 'vitest';
import { resolveAutoSendMode } from './mode.js';

describe('resolveAutoSendMode', () => {
  it('nimmt den restriktiveren Wert', () => {
    expect(resolveAutoSendMode('live', 'shadow')).toBe('shadow');
    expect(resolveAutoSendMode('shadow', 'live')).toBe('shadow');
    expect(resolveAutoSendMode('off', 'live')).toBe('off');
    expect(resolveAutoSendMode('live', 'off')).toBe('off');
  });
  it('ohne Property-Wert gilt der Env-Wert', () => {
    expect(resolveAutoSendMode('live', undefined)).toBe('live');
  });
});
