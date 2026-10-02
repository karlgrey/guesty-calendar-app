// #767: Rate-Limit am Admin-Login (10 Versuche / 15 min je IP), Fehlversuche mit IP im Log.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import type { Server } from 'http';

vi.mock('../repositories/admin-users-repository.js', () => ({
  verifyPassword: vi.fn().mockResolvedValue(null),
}));
vi.mock('../utils/logger.js', () => {
  const l: any = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  l.child = () => l;
  return { default: l, logRequest: vi.fn() };
});

import { configureAuth } from '../config/auth.js';
import authRoutes from './auth.js';
import { LOGIN_RATE_LIMIT_MAX } from '../middleware/login-rate-limit.js';
import logger from '../utils/logger.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  configureAuth();
  app.use(passport.initialize());
  app.use(passport.session());
  app.use('/auth', authRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise((r) => server.close(() => r(undefined))));

const attempt = () =>
  fetch(`${base}/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=angreifer%40example.com&password=falsch',
  });

describe('POST /auth/login Rate-Limit (#767)', () => {
  it(`${LOGIN_RATE_LIMIT_MAX} Fehlversuche → Redirect mit error=invalid und Log-Zeile mit IP, der nächste → 429`, async () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT_MAX; i++) {
      const res = await attempt();
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/auth/login?error=invalid');
    }
    const failedLogs = (logger.warn as any).mock.calls.filter((c: any[]) => c[1] === 'Login failed');
    expect(failedLogs).toHaveLength(LOGIN_RATE_LIMIT_MAX);
    expect(failedLogs[0][0]).toMatchObject({ email: 'angreifer@example.com' });
    expect(typeof failedLogs[0][0].ip).toBe('string');

    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('ratelimit')).toContain('remaining=0');
    const limitLogs = (logger.warn as any).mock.calls.filter((c: any[]) => c[1] === 'Login rate limit exceeded');
    expect(limitLogs).toHaveLength(1);
    expect(limitLogs[0][0]).toMatchObject({ email: 'angreifer@example.com' });
  });
});
