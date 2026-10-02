/**
 * Login-Rate-Limit (#767, nach Phishing-Vorfall #765)
 *
 * Bremst Brute-Force am Admin-Login: je Client-IP höchstens LOGIN_RATE_LIMIT_MAX
 * Versuche in LOGIN_RATE_LIMIT_WINDOW_MS, der nächste bekommt 429 und landet im Log.
 * Zählt JEDEN POST /auth/login (Erfolg wie Fehlschlag): beide enden als 302 und
 * ließen sich sonst nicht unterscheiden; 10 Versuche in 15 Minuten reichen auch
 * einem Menschen, der sich vertippt. IP kommt über `trust proxy` (Caddy) aus
 * X-Forwarded-For.
 */
import { rateLimit } from 'express-rate-limit';
import type { Request, Response } from 'express';
import logger from '../utils/logger.js';

export const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_RATE_LIMIT_MAX = 10;

export function createLoginRateLimiter(options: { windowMs?: number; limit?: number } = {}) {
  return rateLimit({
    windowMs: options.windowMs ?? LOGIN_RATE_LIMIT_WINDOW_MS,
    limit: options.limit ?? LOGIN_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req: Request, res: Response) => {
      logger.warn(
        { ip: req.ip, email: req.body?.email, path: req.originalUrl },
        'Login rate limit exceeded'
      );
      res
        .status(429)
        .type('text/plain')
        .send('Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.');
    },
  });
}

export const loginRateLimiter = createLoginRateLimiter();
