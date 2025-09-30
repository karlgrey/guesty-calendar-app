/**
 * Request Logging Middleware
 */

import type { Request, Response, NextFunction } from 'express';
import { logRequest } from '../utils/logger.js';

/**
 * Log HTTP requests with timing
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const startTime = Date.now();

  // Log after response is finished
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logRequest(req.method, req.path, res.statusCode, duration);
  });

  next();
}