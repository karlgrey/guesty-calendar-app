/**
 * Express Error Handling Middleware
 */

import type { Request, Response, NextFunction } from 'express';
import { isAppError, formatErrorForLog } from '../utils/errors.js';
import logger from '../utils/logger.js';

/**
 * Global error handler middleware
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  // Log error
  logger.error(
    {
      error: formatErrorForLog(err),
      method: req.method,
      path: req.path,
      query: req.query,
    },
    'Request error'
  );

  // Send error response
  if (isAppError(err)) {
    res.status(err.statusCode).json(err.toJSON());
  } else if (err instanceof Error) {
    res.status(500).json({
      error: {
        name: 'InternalServerError',
        message: err.message,
      },
    });
  } else {
    res.status(500).json({
      error: {
        name: 'UnknownError',
        message: 'An unknown error occurred',
      },
    });
  }
}

/**
 * 404 Not Found handler
 */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: {
      name: 'NotFound',
      message: `Route ${req.method} ${req.path} not found`,
      statusCode: 404,
    },
  });
}