/**
 * Authentication Middleware
 *
 * Protects routes by requiring authenticated users
 */

import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger.js';

/**
 * Middleware to require authentication
 * Redirects to login if not authenticated
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.isAuthenticated()) {
    return next();
  }

  logger.warn({ path: req.path, ip: req.ip }, 'Unauthorized access attempt to protected route');

  // Store the original URL to redirect back after login
  req.session.returnTo = req.originalUrl;

  // Redirect to login page
  res.redirect('/auth/login');
}

/**
 * Middleware to check if user is already authenticated
 * Redirects to admin if already logged in
 */
export function redirectIfAuthenticated(req: Request, res: Response, next: NextFunction) {
  if (req.isAuthenticated()) {
    return res.redirect('/admin');
  }
  next();
}
