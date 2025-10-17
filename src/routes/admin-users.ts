/**
 * Admin Users Management Routes
 *
 * API endpoints for managing admin users (CRUD operations)
 */

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  getAllAdminUsers,
  getAdminUserById,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
} from '../repositories/admin-users-repository.js';
import { ValidationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/admin-users
 * Get all admin users
 */
router.get('/', async (_req, res, next) => {
  try {
    const users = getAllAdminUsers();

    // Don't send password hashes to the client
    const sanitizedUsers = users.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      is_active: user.is_active,
      created_at: user.created_at,
      updated_at: user.updated_at,
    }));

    res.json(sanitizedUsers);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/admin-users/:id
 * Get a specific admin user by ID
 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      throw new ValidationError('Invalid user ID');
    }

    const user = getAdminUserById(id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Don't send password hash to the client
    const sanitizedUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      is_active: user.is_active,
      created_at: user.created_at,
      updated_at: user.updated_at,
    };

    return res.json(sanitizedUser);
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /api/admin-users
 * Create a new admin user
 */
router.post('/', async (req, res, next) => {
  try {
    const { email, name, password, is_active } = req.body;

    // Validation
    if (!email || !name || !password) {
      throw new ValidationError('Email, name, and password are required');
    }

    if (typeof email !== 'string' || !email.includes('@')) {
      throw new ValidationError('Invalid email address');
    }

    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ValidationError('Name cannot be empty');
    }

    if (typeof password !== 'string' || password.length < 8) {
      throw new ValidationError('Password must be at least 8 characters');
    }

    const user = await createAdminUser(
      email.toLowerCase().trim(),
      name.trim(),
      password,
      is_active !== undefined ? Boolean(is_active) : true
    );

    logger.info({ userId: user.id, email: user.email }, 'Admin user created via API');

    // Don't send password hash to the client
    const sanitizedUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      is_active: user.is_active,
      created_at: user.created_at,
      updated_at: user.updated_at,
    };

    res.status(201).json(sanitizedUser);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/admin-users/:id
 * Update an existing admin user
 */
router.put('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      throw new ValidationError('Invalid user ID');
    }

    const { email, name, password, is_active } = req.body;
    const updates: any = {};

    if (email !== undefined) {
      if (typeof email !== 'string' || !email.includes('@')) {
        throw new ValidationError('Invalid email address');
      }
      updates.email = email.toLowerCase().trim();
    }

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        throw new ValidationError('Name cannot be empty');
      }
      updates.name = name.trim();
    }

    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 8) {
        throw new ValidationError('Password must be at least 8 characters');
      }
      updates.password = password;
    }

    if (is_active !== undefined) {
      updates.is_active = Boolean(is_active);
    }

    if (Object.keys(updates).length === 0) {
      throw new ValidationError('No fields to update');
    }

    const user = await updateAdminUser(id, updates);

    logger.info({ userId: id, updates: Object.keys(updates) }, 'Admin user updated via API');

    // Don't send password hash to the client
    const sanitizedUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      is_active: user.is_active,
      created_at: user.created_at,
      updated_at: user.updated_at,
    };

    res.json(sanitizedUser);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/admin-users/:id
 * Delete an admin user
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);

    if (isNaN(id)) {
      throw new ValidationError('Invalid user ID');
    }

    deleteAdminUser(id);

    logger.info({ userId: id }, 'Admin user deleted via API');

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export default router;
