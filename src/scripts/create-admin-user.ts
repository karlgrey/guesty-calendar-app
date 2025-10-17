/**
 * Create Initial Admin User Script
 *
 * Manually create an admin user for bootstrapping the system
 * Usage: npx tsx src/scripts/create-admin-user.ts
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { initDatabase } from '../db/index.js';
import { createAdminUser, getAdminUserByEmail } from '../repositories/admin-users-repository.js';

async function main() {
  const rl = readline.createInterface({ input, output });

  try {
    console.log('===========================================');
    console.log('Create Admin User');
    console.log('===========================================\n');

    // Initialize database connection
    initDatabase();

    // Prompt for user details
    const email = await rl.question('Email: ');
    if (!email || !email.includes('@')) {
      console.error('Error: Invalid email address');
      process.exit(1);
    }

    // Check if user already exists
    const existingUser = getAdminUserByEmail(email);
    if (existingUser) {
      console.error(`Error: User with email "${email}" already exists`);
      process.exit(1);
    }

    const name = await rl.question('Name: ');
    if (!name || name.trim().length === 0) {
      console.error('Error: Name cannot be empty');
      process.exit(1);
    }

    const password = await rl.question('Password (min 8 characters): ');
    if (!password || password.length < 8) {
      console.error('Error: Password must be at least 8 characters');
      process.exit(1);
    }

    const confirmPassword = await rl.question('Confirm Password: ');
    if (password !== confirmPassword) {
      console.error('Error: Passwords do not match');
      process.exit(1);
    }

    // Create the user
    const user = await createAdminUser(email.toLowerCase().trim(), name.trim(), password, true);

    console.log('\n✓ Admin user created successfully!');
    console.log(`  ID: ${user.id}`);
    console.log(`  Email: ${user.email}`);
    console.log(`  Name: ${user.name}`);
    console.log(`  Status: ${user.is_active ? 'Active' : 'Inactive'}`);
    console.log('\nYou can now log in at /auth/login');
  } catch (error) {
    console.error('\nError creating admin user:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
