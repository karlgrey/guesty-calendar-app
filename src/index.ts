/**
 * Main Application Entry Point
 */

import { createApp } from './app.js';
import { config } from './config/index.js';
import { initDatabase, executeSchema, isDatabaseInitialized, closeDatabase } from './db/index.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import logger from './utils/logger.js';

/**
 * Start the server
 */
async function start() {
  try {
    logger.info('Starting Guesty Calendar App...');

    // Initialize database
    logger.info('Initializing database...');
    initDatabase();

    // Check if database is initialized, run schema if not
    if (!isDatabaseInitialized()) {
      logger.info('Database not initialized. Running schema...');
      executeSchema();
      logger.info('Database schema applied successfully');
    } else {
      logger.info('Database already initialized');
    }

    // Create Express app
    const app = createApp();

    // Start server
    const server = app.listen(config.port, config.host, () => {
      logger.info(
        {
          host: config.host,
          port: config.port,
          env: config.nodeEnv,
        },
        `Server running at http://${config.host}:${config.port}`
      );
      logger.info(`Admin dashboard: http://${config.host}:${config.port}/admin`);
      logger.info(`Health check: http://${config.host}:${config.port}/health`);
    });

    // Start job scheduler
    logger.info('Starting scheduled ETL jobs...');
    startScheduler();

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received, shutting down gracefully...`);

      // Stop scheduler
      stopScheduler();

      server.close(() => {
        logger.info('HTTP server closed');

        // Close database connection
        closeDatabase();
        logger.info('Database connection closed');

        process.exit(0);
      });

      // Force shutdown after 10 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
}

// Start the application
start();