/**
 * Sync Routes
 *
 * Manual triggers for ETL jobs (admin/debug endpoints).
 */

import express from 'express';
import { runETLJob } from '../jobs/etl-job.js';
import { syncConfiguredListing } from '../jobs/sync-listing.js';
import { syncConfiguredAvailability } from '../jobs/sync-availability.js';
import { getSchedulerStatus } from '../jobs/scheduler.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * POST /sync/all
 * Trigger full ETL job (listing + availability)
 */
router.post('/all', async (req, res) => {
  try {
    const force = req.query.force === 'true';

    logger.info({ force, triggeredBy: 'manual' }, 'Manual ETL job triggered');

    const result = await runETLJob(force);

    res.json({
      success: result.success,
      message: result.success ? 'ETL job completed successfully' : 'ETL job completed with errors',
      result,
    });
  } catch (error) {
    logger.error({ error }, 'Manual ETL job failed');
    res.status(500).json({
      success: false,
      message: 'ETL job failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /sync/listing
 * Trigger listing sync only
 */
router.post('/listing', async (req, res) => {
  try {
    const force = req.query.force === 'true';

    logger.info({ force, triggeredBy: 'manual' }, 'Manual listing sync triggered');

    const result = await syncConfiguredListing(force);

    res.json({
      success: result.success,
      message: result.success
        ? result.skipped
          ? 'Listing cache is fresh, no sync needed'
          : 'Listing synced successfully'
        : 'Listing sync failed',
      result,
    });
  } catch (error) {
    logger.error({ error }, 'Manual listing sync failed');
    res.status(500).json({
      success: false,
      message: 'Listing sync failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /sync/availability
 * Trigger availability sync only
 */
router.post('/availability', async (req, res) => {
  try {
    const force = req.query.force === 'true';

    logger.info({ force, triggeredBy: 'manual' }, 'Manual availability sync triggered');

    const result = await syncConfiguredAvailability(force);

    res.json({
      success: result.success,
      message: result.success
        ? result.skipped
          ? 'Availability cache is fresh, no sync needed'
          : 'Availability synced successfully'
        : 'Availability sync failed',
      result,
    });
  } catch (error) {
    logger.error({ error }, 'Manual availability sync failed');
    res.status(500).json({
      success: false,
      message: 'Availability sync failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /sync/status
 * Get sync job status and scheduler info
 */
router.get('/status', (_req, res) => {
  try {
    const schedulerStatus = getSchedulerStatus();

    res.json({
      scheduler: schedulerStatus,
      endpoints: {
        syncAll: 'POST /sync/all?force=true',
        syncListing: 'POST /sync/listing?force=true',
        syncAvailability: 'POST /sync/availability?force=true',
      },
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get sync status');
    res.status(500).json({
      success: false,
      message: 'Failed to get sync status',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;