/**
 * Agent-API Key Middleware
 *
 * Schützt /api/agent/* mit einem statischen Key (Header X-Agent-Key).
 * Ohne konfigurierten AGENT_API_KEY ist die Agent-API deaktiviert (503).
 */
import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';

export function requireAgentKey(req: Request, res: Response, next: NextFunction): void {
  const expected = config.agentApiKey;
  if (!expected) {
    res.status(503).json({ error: 'Agent API is not configured' });
    return;
  }

  const provided = req.header('X-Agent-Key');
  if (!provided || provided.length !== expected.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    logger.warn({ path: req.path, ip: req.ip }, 'Agent API: invalid or missing key');
    res.status(401).json({ error: 'Invalid agent key' });
    return;
  }

  next();
}
