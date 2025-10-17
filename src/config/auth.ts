/**
 * Authentication Configuration
 *
 * Sets up Passport.js with local username/password strategy
 */

import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { verifyPassword } from '../repositories/admin-users-repository.js';
import logger from '../utils/logger.js';

/**
 * User profile stored in session
 */
export interface UserProfile {
  id: number;
  email: string;
  name: string;
}

/**
 * Configure Passport.js with local username/password strategy
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

  // Local Strategy
  passport.use(
    new LocalStrategy(
      {
        usernameField: 'email',
        passwordField: 'password',
      },
      async (email, password, done) => {
        try {
          // Verify password and get user
          const user = await verifyPassword(email, password);

          if (!user) {
            logger.warn({ email }, 'Failed login attempt');
            return done(null, false, { message: 'Invalid email or password' });
          }

          const userProfile: UserProfile = {
            id: user.id,
            email: user.email,
            name: user.name,
          };

          logger.info({ email, name: user.name }, 'User authenticated successfully');

          return done(null, userProfile);
        } catch (error) {
          logger.error({ error, email }, 'Error during authentication');
          return done(error);
        }
      }
    )
  );

  logger.info('Authentication configured with local strategy');
}
