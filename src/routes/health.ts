/**
 * Health Check Routes
 */

import express from 'express';
import { getDatabase, isDatabaseInitialized, getDatabaseStats } from '../db/index.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { guestyClient } from '../services/guesty-client.js';
import { getGuestyRequestDailyStats } from '../services/guesty-request-telemetry.js';

const router = express.Router();

/**
 * GET /health
 * Basic health check endpoint
 */
router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'guesty-calendar-app',
    version: '1.0.0',
  });
});

/**
 * GET /health/detailed
 * Detailed health check with database status
 */
router.get('/detailed', (_req, res) => {
  try {
    const db = getDatabase();
    const isDbInitialized = isDatabaseInitialized();

    let dbStats = null;
    if (isDbInitialized) {
      dbStats = getDatabaseStats();
    }

    // Guesty-API-Last (#772) — Fehler hier dürfen den Health-Check nie kippen
    let guestyRequests: unknown;
    try {
      const last7Days = getGuestyRequestDailyStats(7);
      guestyRequests = {
        today: last7Days[0] ?? null,
        last7Days,
        rateLimit: guestyClient.getRateLimitInfo(),
      };
    } catch (error) {
      guestyRequests = { error: error instanceof Error ? error.message : 'Unknown error' };
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'guesty-calendar-app',
      version: '1.0.0',
      environment: config.nodeEnv,
      database: {
        connected: !!db,
        initialized: isDbInitialized,
        stats: dbStats,
      },
      guestyRequests,
      config: {
        propertyId: config.guestyPropertyId,
        currency: config.propertyCurrency,
        timezone: config.propertyTimezone,
        caching: {
          listingTtl: `${config.cacheListingTtl}h`,
          availabilityTtl: `${config.cacheAvailabilityTtl}h`,
          quoteTtl: `${config.cacheQuoteTtl}h`,
        },
      },
    });
  } catch (error) {
    logger.error({ error }, 'Health check failed');
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      message: 'Service unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /health/ready
 * Kubernetes-style readiness probe
 */
router.get('/ready', (_req, res) => {
  try {
    const db = getDatabase();
    const isDbInitialized = isDatabaseInitialized();

    if (!db || !isDbInitialized) {
      return res.status(503).json({
        status: 'not_ready',
        message: 'Database not initialized',
      });
    }

    return res.json({
      status: 'ready',
    });
  } catch (error) {
    return res.status(503).json({
      status: 'not_ready',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /health/live
 * Kubernetes-style liveness probe
 */
router.get('/live', (_req, res) => {
  res.json({
    status: 'alive',
  });
});

export default router;