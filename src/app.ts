/**
 * Express Application Setup
 */

import express from 'express';
import { requestLogger } from './middleware/request-logger.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import healthRoutes from './routes/health.js';
import syncRoutes from './routes/sync.js';
import listingRoutes from './routes/listing.js';
import availabilityRoutes from './routes/availability.js';
import quoteRoutes from './routes/quote.js';

/**
 * Create and configure Express application
 */
export function createApp() {
  const app = express();

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLogger);

  // Serve static files (calendar UI)
  app.use(express.static('public'));

  // CORS headers (for frontend)
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  // Routes
  app.use('/health', healthRoutes);
  app.use('/sync', syncRoutes);

  // Public API routes
  app.use('/listing', listingRoutes);
  app.use('/availability', availabilityRoutes);
  app.use('/quote', quoteRoutes);

  // 404 handler (must be after all routes)
  app.use(notFoundHandler);

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}