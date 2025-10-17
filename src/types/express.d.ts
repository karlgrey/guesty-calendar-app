/**
 * Express type extensions for Passport authentication
 */

import { UserProfile } from '../config/auth.js';

declare global {
  namespace Express {
    interface User extends UserProfile {}
  }
}

declare module 'express-session' {
  interface SessionData {
    returnTo?: string;
  }
}

export {};
