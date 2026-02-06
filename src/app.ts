/**
 * Express Application Setup
 */

import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { config } from './config/index.js';
import { configureAuth } from './config/auth.js';
import { requestLogger } from './middleware/request-logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requireAuth } from './middleware/auth.js';
import healthRoutes from './routes/health.js';
import syncRoutes from './routes/sync.js';
import listingRoutes from './routes/listing.js';
import availabilityRoutes from './routes/availability.js';
import quoteRoutes from './routes/quote.js';
import debugRoutes from './routes/debug.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import adminUsersRoutes from './routes/admin-users.js';
import propertyRoutes from './routes/property-routes.js';

/**
 * Create and configure Express application
 */
export function createApp() {
  const app = express();

  // Trust proxy - required for secure cookies behind reverse proxy (Caddy/nginx)
  app.set('trust proxy', 1);

  // Configure authentication
  configureAuth();

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  // Session middleware (required for Passport)
  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: config.nodeEnv === 'production', // HTTPS only in production
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: 'lax', // Required for OAuth redirects
      },
      proxy: true, // Trust proxy for secure cookies
    })
  );

  // Initialize Passport
  app.use(passport.initialize());
  app.use(passport.session());

  // Serve static files (calendar UI)
  app.use(express.static('public'));

  // CORS headers (for frontend)
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  // Authentication routes (public)
  app.use('/auth', authRoutes);

  // Routes
  app.use('/health', healthRoutes);
  app.use('/sync', syncRoutes);
  app.use('/debug', debugRoutes);

  // Protected admin routes (require authentication)
  app.use('/admin', requireAuth, adminRoutes);
  app.use('/api/admin-users', adminUsersRoutes); // requireAuth is applied within the router

  // Property-specific API routes (multi-property support)
  app.use('/p', propertyRoutes);

  // Public API routes (legacy, uses default property)
  app.use('/listing', listingRoutes);
  app.use('/availability', availabilityRoutes);
  app.use('/quote', quoteRoutes);

  // 404 handler (must be after all routes)
  app.use(notFoundHandler);

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}