// #772: Minuten-Reservoir im Guesty-Limiter (Guesty: 15/s, 120/min, 5000/h).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createGuestyLimiter, GUESTY_LIMITS } from './guesty-client.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createGuestyLimiter', () => {
  it('Limits liegen mit Puffer unter Guestys 15/s und 120/min', () => {
    expect(GUESTY_LIMITS.perSecond).toBeLessThan(15);
    expect(GUESTY_LIMITS.perMinute).toBeLessThan(120);
  });

  it('lässt je Minute nur perMinute Jobs durch, den Rest nach 60 s', async () => {
    vi.useFakeTimers();
    const limiter = createGuestyLimiter({ perSecond: 100, maxConcurrent: 10, minTimeMs: 0, perMinute: 3 });
    const ran: number[] = [];
    const jobs = [1, 2, 3, 4, 5].map((n) => limiter.schedule(async () => { ran.push(n); return n; }));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(ran).toEqual([1, 2, 3]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(ran).toEqual([1, 2, 3, 4, 5]);
    await expect(Promise.all(jobs)).resolves.toEqual([1, 2, 3, 4, 5]);
    await limiter.stop({ dropWaitingJobs: true });
  });
});
