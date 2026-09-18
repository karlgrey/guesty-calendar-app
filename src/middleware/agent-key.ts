/**
 * Agent-API Key Middleware
 *
 * Schützt /api/agent/* gegen eine Menge statischer Keys (Header X-Agent-Key):
 * Vereinigungsmenge aus AGENT_API_KEY (Legacy-Einzelwert) und AGENT_API_KEYS
 * (kommagetrennte Liste, z. B. ein eigener Key pro Client) — beide gelten
 * gleichberechtigt, aufgelöst in `config.agentApiKeySet`.
 * Ohne konfigurierten Key ist die Agent-API deaktiviert (503).
 */
import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

function timingSafeMatch(provided: string, expected: string): boolean {
  return provided.length === expected.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function requireAgentKey(req: Request, res: Response, next: NextFunction): void {
  const validKeys = config.agentApiKeySet;
  if (validKeys.length === 0) {
    res.status(503).json({ error: 'Agent API is not configured' });
    return;
  }

  const provided = req.header('X-Agent-Key');
  const isValid = !!provided && validKeys.some((key) => timingSafeMatch(provided, key));
  if (!isValid) {
    logger.warn({ path: req.path, ip: req.ip }, 'Agent API: invalid or missing key');
    res.status(401).json({ error: 'Invalid agent key' });
    return;
  }

  next();
}
