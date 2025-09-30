/**
 * Availability Routes
 *
 * Public read-only endpoint for calendar availability.
 */

import express from 'express';
import { getAvailability } from '../repositories/availability-repository.js';
import { config } from '../config/index.js';
import { ValidationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Validate date format (YYYY-MM-DD)
 */
function isValidDate(dateString: string): boolean {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateString)) {
    return false;
  }
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date.getTime());
}

/**
 * GET /availability?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Get availability for a date range
 */
router.get('/', (req, res, next) => {
  try {
    const { from, to } = req.query;

    // Validate required parameters
    if (!from || !to) {
      throw new ValidationError('Missing required parameters: from and to (YYYY-MM-DD format)');
    }

    // Validate date format
    if (!isValidDate(from as string) || !isValidDate(to as string)) {
      throw new ValidationError('Invalid date format. Use YYYY-MM-DD (e.g., 2025-04-15)');
    }

    // Validate date range
    const fromDate = new Date(from as string);
    const toDate = new Date(to as string);

    if (fromDate > toDate) {
      throw new ValidationError('From date must be before or equal to to date');
    }

    // Check range isn't too large (max 12 months)
    const daysDiff = (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysDiff > 365) {
      throw new ValidationError('Date range cannot exceed 365 days');
    }

    // Fetch availability from database
    const availability = getAvailability(config.guestyPropertyId, from as string, to as string);

    // Transform to public response format
    const response = availability.map((day) => ({
      date: day.date,
      status: day.status,
      price: day.price,
      minNights: day.min_nights,
      closedToArrival: day.closed_to_arrival,
      closedToDeparture: day.closed_to_departure,
    }));

    logger.debug({ from, to, count: response.length }, 'Availability data retrieved');

    res.json({
      from,
      to,
      currency: config.propertyCurrency,
      days: response,
    });
  } catch (error) {
    next(error);
  }
});

export default router;