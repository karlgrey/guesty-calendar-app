/**
 * Logger Module
 *
 * Provides structured logging using Pino.
 * Supports different log levels and pretty printing in development.
 */

import pino from 'pino';
import { config, isDevelopment } from '../config/index.js';

/**
 * Create logger instance with configuration
 */
const logger = pino({
  level: config.logLevel,
  transport: config.logPretty && isDevelopment
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          singleLine: false,
        },
      }
    : undefined,
  base: {
    env: config.nodeEnv,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export default logger;

/**
 * Create a child logger with additional context
 */
export function createLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

/**
 * Log request middleware helper
 */
export function logRequest(method: string, path: string, statusCode: number, duration: number) {
  logger.info(
    {
      method,
      path,
      statusCode,
      duration: `${duration}ms`,
    },
    `${method} ${path} - ${statusCode} (${duration}ms)`
  );
}

/**
 * Log database operation
 */
export function logDbOperation(operation: string, table: string, duration: number, recordCount?: number) {
  logger.debug(
    {
      operation,
      table,
      duration: `${duration}ms`,
      recordCount,
    },
    `DB ${operation} on ${table} (${duration}ms)${recordCount !== undefined ? ` - ${recordCount} records` : ''}`
  );
}

/**
 * Log external API call
 */
export function logApiCall(service: string, endpoint: string, statusCode: number, duration: number) {
  const logLevel = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';

  logger[logLevel](
    {
      service,
      endpoint,
      statusCode,
      duration: `${duration}ms`,
    },
    `API ${service} ${endpoint} - ${statusCode} (${duration}ms)`
  );
}