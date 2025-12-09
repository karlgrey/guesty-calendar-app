#!/usr/bin/env npx tsx
/**
 * Weekly Backup Script
 *
 * Creates a backup of the SQLite database and config files, sends via email.
 * Config files (.env, ga4-service-account.json) are sent as encrypted ZIP.
 * Run via cron: 0 2 * * 5 (Fridays at 2 AM)
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Resend } from 'resend';
import { config } from '../config/index.js';

const BACKUP_DIR = '/opt/backups';
const APP_DIR = process.cwd();
const DB_PATH = path.join(APP_DIR, 'data', 'calendar.db');
const ENV_PATH = path.join(APP_DIR, '.env');
const GA4_PATH = path.join(APP_DIR, 'data', 'ga4-service-account.json');
const RECIPIENT = 'micha@remoterepublic.com';

// Password for the encrypted config ZIP
// Using a fixed password so you can always decrypt it
const CONFIG_ZIP_PASSWORD = 'FarmhousePrasser2025!';

async function main() {
  console.log('Starting weekly backup...');

  const date = new Date().toISOString().split('T')[0];
  const dbBackupFilename = `calendar_backup_${date}.db`;
  const dbBackupPath = path.join(BACKUP_DIR, dbBackupFilename);
  const configZipFilename = `config_backup_${date}.zip`;
  const configZipPath = path.join(BACKUP_DIR, configZipFilename);

  // Create database backup using SQLite .backup command (ensures consistency)
  console.log('Creating database backup...');
  try {
    execSync(`sqlite3 "${DB_PATH}" ".backup '${dbBackupPath}'"`, { stdio: 'inherit' });
  } catch (error) {
    console.error('Failed to create database backup:', error);
    process.exit(1);
  }

  // Verify database backup was created
  if (!fs.existsSync(dbBackupPath)) {
    console.error('Database backup file was not created');
    process.exit(1);
  }

  const dbStats = fs.statSync(dbBackupPath);
  console.log(`Database backup created: ${dbBackupFilename} (${(dbStats.size / 1024).toFixed(2)} KB)`);

  // Create encrypted ZIP with config files
  console.log('Creating encrypted config backup...');
  try {
    // Create ZIP with password encryption (-e uses standard encryption, -P sets password)
    execSync(
      `zip -j -P "${CONFIG_ZIP_PASSWORD}" "${configZipPath}" "${ENV_PATH}" "${GA4_PATH}"`,
      { stdio: 'inherit' }
    );
  } catch (error) {
    console.error('Failed to create config backup:', error);
    process.exit(1);
  }

  // Verify config backup was created
  if (!fs.existsSync(configZipPath)) {
    console.error('Config backup file was not created');
    process.exit(1);
  }

  const configStats = fs.statSync(configZipPath);
  console.log(`Config backup created: ${configZipFilename} (${(configStats.size / 1024).toFixed(2)} KB)`);

  // Read backup files for email attachment
  const dbBackupData = fs.readFileSync(dbBackupPath);
  const configBackupData = fs.readFileSync(configZipPath);

  // Send email with backup attachments
  console.log('Sending backup email...');

  const resend = new Resend(config.resendApiKey);

  try {
    const result = await resend.emails.send({
      from: `${config.emailFromName} <${config.emailFromAddress}>`,
      to: RECIPIENT,
      subject: `Farmhouse Prasser - Weekly Backup ${date}`,
      html: `
        <h2>Weekly Backup</h2>
        <p>Attached are the weekly backups of the Guesty Calendar application.</p>

        <h3>Attachments:</h3>
        <ul>
          <li><strong>${dbBackupFilename}</strong> - SQLite Database (${(dbStats.size / 1024).toFixed(2)} KB)</li>
          <li><strong>${configZipFilename}</strong> - Encrypted Config Files (${(configStats.size / 1024).toFixed(2)} KB)</li>
        </ul>

        <h3>Config ZIP Password:</h3>
        <p style="font-family: monospace; background: #f5f5f5; padding: 10px; border-radius: 4px;">
          ${CONFIG_ZIP_PASSWORD}
        </p>

        <h3>Contents of Config ZIP:</h3>
        <ul>
          <li><code>.env</code> - Environment variables and API keys</li>
          <li><code>ga4-service-account.json</code> - Google Analytics credentials</li>
        </ul>

        <h3>To Restore:</h3>
        <ol>
          <li>Replace <code>data/calendar.db</code> with the database backup</li>
          <li>Unzip config files to project root (overwrite .env) and data/ folder</li>
          <li>Restart the server: <code>pm2 restart guesty-calendar</code></li>
        </ol>

        <hr>
        <p style="color: #666; font-size: 12px;">
          Automated backup from Guesty Calendar App<br>
          Date: ${date}
        </p>
      `,
      text: `Weekly Backup - ${date}\n\nAttachments:\n- ${dbBackupFilename} (Database)\n- ${configZipFilename} (Encrypted Config)\n\nConfig ZIP Password: ${CONFIG_ZIP_PASSWORD}\n\nTo restore:\n1. Replace data/calendar.db with the database backup\n2. Unzip config files\n3. Restart server: pm2 restart guesty-calendar`,
      attachments: [
        {
          filename: dbBackupFilename,
          content: dbBackupData.toString('base64'),
        },
        {
          filename: configZipFilename,
          content: configBackupData.toString('base64'),
        },
      ],
    });

    console.log('Backup email sent successfully:', result.data?.id);
  } catch (error) {
    console.error('Failed to send backup email:', error);
    process.exit(1);
  }

  // Clean up old local backups (keep last 4 weeks)
  console.log('Cleaning up old backups...');

  // Clean database backups
  const dbFiles = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('calendar_backup_') && f.endsWith('.db'))
    .sort()
    .reverse();

  for (const file of dbFiles.slice(4)) {
    const filePath = path.join(BACKUP_DIR, file);
    fs.unlinkSync(filePath);
    console.log(`Deleted old backup: ${file}`);
  }

  // Clean config backups
  const configFiles = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('config_backup_') && f.endsWith('.zip'))
    .sort()
    .reverse();

  for (const file of configFiles.slice(4)) {
    const filePath = path.join(BACKUP_DIR, file);
    fs.unlinkSync(filePath);
    console.log(`Deleted old backup: ${file}`);
  }

  console.log('Weekly backup completed successfully!');
}

main().catch(error => {
  console.error('Backup failed:', error);
  process.exit(1);
});
