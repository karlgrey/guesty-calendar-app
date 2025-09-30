/**
 * Error Handling Utilities
 *
 * Custom error classes and error handling utilities.
 */

/**
 * Base application error
 */
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code?: string,
    public details?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: {
        name: this.name,
        message: this.message,
        code: this.code,
        statusCode: this.statusCode,
        details: this.details,
      },
    };
  }
}

/**
 * Configuration error (invalid config)
 */
export class ConfigError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 500, 'CONFIG_ERROR', details);
  }
}

/**
 * Database error
 */
export class DatabaseError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 500, 'DATABASE_ERROR', details);
  }
}

/**
 * External API error (Guesty API)
 */
export class ExternalApiError extends AppError {
  constructor(
    message: string,
    statusCode: number = 502,
    public service?: string,
    details?: unknown
  ) {
    super(message, statusCode, 'EXTERNAL_API_ERROR', details);
  }
}

/**
 * Validation error (invalid input)
 */
export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

/**
 * Not found error
 */
export class NotFoundError extends AppError {
  constructor(message: string = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

/**
 * Cache miss error (not critical, used for flow control)
 */
export class CacheMissError extends Error {
  constructor(message: string = 'Cache miss') {
    super(message);
    this.name = 'CacheMissError';
  }
}

/**
 * Check if error is an instance of AppError
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Safe error message extraction
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Format error for logging
 */
export function formatErrorForLog(error: unknown) {
  if (error instanceof AppError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
      details: error.details,
      stack: error.stack,
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}