/**
 * Admin Users Repository
 *
 * Database operations for admin_users table.
 */

import bcrypt from 'bcrypt';
import { getDatabase } from '../db/index.js';
import { DatabaseError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import type { AdminUser, AdminUserRow } from '../types/models.js';
import { rowToAdminUser } from '../types/models.js';

const SALT_ROUNDS = 10;

/**
 * Create a new admin user
 */
export async function createAdminUser(
  email: string,
  name: string,
  password: string,
  isActive: boolean = true
): Promise<AdminUser> {
  const db = getDatabase();

  try {
    // Hash the password
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    // Insert the user
    const stmt = db.prepare(`
      INSERT INTO admin_users (email, name, password_hash, is_active)
      VALUES (?, ?, ?, ?)
    `);

    const result = stmt.run(email, name, passwordHash, isActive ? 1 : 0);

    logger.info({ email, userId: result.lastInsertRowid }, 'Admin user created successfully');

    // Return the created user
    const user = getAdminUserById(Number(result.lastInsertRowid));
    if (!user) {
      throw new DatabaseError('Failed to retrieve created user');
    }

    return user;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      logger.error({ email }, 'Email already exists');
      throw new DatabaseError('Email already exists');
    }
    logger.error({ error, email }, 'Failed to create admin user');
    throw new DatabaseError(`Failed to create admin user: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get admin user by ID
 */
export function getAdminUserById(id: number): AdminUser | null {
  const db = getDatabase();

  try {
    const row = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id) as AdminUserRow | undefined;

    if (!row) {
      return null;
    }

    return rowToAdminUser(row);
  } catch (error) {
    logger.error({ error, userId: id }, 'Failed to get admin user');
    throw new DatabaseError(`Failed to get admin user: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get admin user by email
 */
export function getAdminUserByEmail(email: string): AdminUser | null {
  const db = getDatabase();

  try {
    const row = db.prepare('SELECT * FROM admin_users WHERE email = ?').get(email) as AdminUserRow | undefined;

    if (!row) {
      return null;
    }

    return rowToAdminUser(row);
  } catch (error) {
    logger.error({ error, email }, 'Failed to get admin user by email');
    throw new DatabaseError(`Failed to get admin user: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get all admin users
 */
export function getAllAdminUsers(): AdminUser[] {
  const db = getDatabase();

  try {
    const rows = db.prepare('SELECT * FROM admin_users ORDER BY created_at DESC').all() as AdminUserRow[];

    return rows.map(rowToAdminUser);
  } catch (error) {
    logger.error({ error }, 'Failed to get admin users');
    throw new DatabaseError(`Failed to get admin users: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get all active admin users
 */
export function getActiveAdminUsers(): AdminUser[] {
  const db = getDatabase();

  try {
    const rows = db.prepare('SELECT * FROM admin_users WHERE is_active = 1 ORDER BY created_at DESC').all() as AdminUserRow[];

    return rows.map(rowToAdminUser);
  } catch (error) {
    logger.error({ error }, 'Failed to get active admin users');
    throw new DatabaseError(`Failed to get active admin users: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Update admin user
 */
export async function updateAdminUser(
  id: number,
  updates: {
    email?: string;
    name?: string;
    password?: string;
    is_active?: boolean;
  }
): Promise<AdminUser> {
  const db = getDatabase();

  try {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.email !== undefined) {
      fields.push('email = ?');
      values.push(updates.email);
    }

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }

    if (updates.password !== undefined) {
      const passwordHash = await bcrypt.hash(updates.password, SALT_ROUNDS);
      fields.push('password_hash = ?');
      values.push(passwordHash);
    }

    if (updates.is_active !== undefined) {
      fields.push('is_active = ?');
      values.push(updates.is_active ? 1 : 0);
    }

    if (fields.length === 0) {
      throw new DatabaseError('No fields to update');
    }

    values.push(id);

    const stmt = db.prepare(`
      UPDATE admin_users
      SET ${fields.join(', ')}, updated_at = datetime('now')
      WHERE id = ?
    `);

    const result = stmt.run(...values);

    if (result.changes === 0) {
      throw new DatabaseError('User not found');
    }

    logger.info({ userId: id, updates: Object.keys(updates) }, 'Admin user updated successfully');

    const user = getAdminUserById(id);
    if (!user) {
      throw new DatabaseError('Failed to retrieve updated user');
    }

    return user;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      logger.error({ id, email: updates.email }, 'Email already exists');
      throw new DatabaseError('Email already exists');
    }
    logger.error({ error, userId: id }, 'Failed to update admin user');
    throw new DatabaseError(`Failed to update admin user: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Delete admin user
 */
export function deleteAdminUser(id: number): void {
  const db = getDatabase();

  try {
    const stmt = db.prepare('DELETE FROM admin_users WHERE id = ?');
    const result = stmt.run(id);

    if (result.changes === 0) {
      throw new DatabaseError('User not found');
    }

    logger.info({ userId: id }, 'Admin user deleted successfully');
  } catch (error) {
    logger.error({ error, userId: id }, 'Failed to delete admin user');
    throw new DatabaseError(`Failed to delete admin user: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Verify user password
 */
export async function verifyPassword(email: string, password: string): Promise<AdminUser | null> {
  const user = getAdminUserByEmail(email);

  if (!user) {
    // User not found - still hash to prevent timing attacks
    await bcrypt.hash(password, SALT_ROUNDS);
    return null;
  }

  if (!user.is_active) {
    // User is inactive
    return null;
  }

  const isValid = await bcrypt.compare(password, user.password_hash);

  if (!isValid) {
    return null;
  }

  return user;
}
