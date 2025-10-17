/**
 * Authentication Configuration
 *
 * Sets up Passport.js with Google OAuth 2.0 strategy
 */

import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { config } from './index.js';
import logger from '../utils/logger.js';

/**
 * User profile stored in session
 */
export interface UserProfile {
  id: string;
  email: string;
  name: string;
  picture?: string;
}

/**
 * Check if email is allowed to access admin
 */
export function isEmailAllowed(email: string): boolean {
  const normalizedEmail = email.toLowerCase().trim();
  return config.adminAllowedEmails.includes(normalizedEmail);
}

/**
 * Configure Passport.js with Google OAuth strategy
 */
export function configureAuth() {
  // Serialize user to session
  passport.serializeUser((user: Express.User, done) => {
    done(null, user);
  });

  // Deserialize user from session
  passport.deserializeUser((user: Express.User, done) => {
    done(null, user);
  });

  // Google OAuth Strategy
  passport.use(
    new GoogleStrategy(
      {
        clientID: config.googleClientId,
        clientSecret: config.googleClientSecret,
        callbackURL: `${config.baseUrl}/auth/google/callback`,
        scope: ['profile', 'email'],
      },
      (_accessToken, _refreshToken, profile, done) => {
        // Extract user info from Google profile
        const email = profile.emails?.[0]?.value;

        if (!email) {
          logger.warn({ profile }, 'Google profile missing email');
          return done(new Error('No email found in Google profile'));
        }

        // Check if email is whitelisted
        if (!isEmailAllowed(email)) {
          logger.warn({ email }, 'Unauthorized email attempted to access admin');
          return done(new Error('Email not authorized'));
        }

        const user: UserProfile = {
          id: profile.id,
          email: email,
          name: profile.displayName || 'Unknown User',
          picture: profile.photos?.[0]?.value,
        };

        logger.info({ email, name: user.name }, 'User authenticated successfully');

        return done(null, user);
      }
    )
  );

  logger.info('Authentication configured with Google OAuth');
}
