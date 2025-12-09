#!/usr/bin/env npx tsx
/**
 * Weekly Backup Script
 *
 * Creates a backup of the SQLite database and sends it via email.
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
const RECIPIENT = 'micha@remoterepublic.com';

async function main() {
  console.log('Starting weekly backup...');

  const date = new Date().toISOString().split('T')[0];
  const backupFilename = `calendar_backup_${date}.db`;
  const backupPath = path.join(BACKUP_DIR, backupFilename);

  // Create backup using SQLite .backup command (ensures consistency)
  console.log('Creating database backup...');
  try {
    execSync(`sqlite3 "${DB_PATH}" ".backup '${backupPath}'"`, { stdio: 'inherit' });
  } catch (error) {
    console.error('Failed to create backup:', error);
    process.exit(1);
  }

  // Verify backup was created
  if (!fs.existsSync(backupPath)) {
    console.error('Backup file was not created');
    process.exit(1);
  }

  const stats = fs.statSync(backupPath);
  console.log(`Backup created: ${backupFilename} (${(stats.size / 1024).toFixed(2)} KB)`);

  // Read backup file for email attachment
  const backupData = fs.readFileSync(backupPath);

  // Send email with backup attachment
  console.log('Sending backup email...');

  const resend = new Resend(config.resendApiKey);

  try {
    const result = await resend.emails.send({
      from: `${config.emailFromName} <${config.emailFromAddress}>`,
      to: RECIPIENT,
      subject: `Farmhouse Prasser - Weekly Backup ${date}`,
      html: `
        <h2>Weekly Database Backup</h2>
        <p>Attached is the weekly backup of the Guesty Calendar database.</p>
        <ul>
          <li><strong>Date:</strong> ${date}</li>
          <li><strong>File:</strong> ${backupFilename}</li>
          <li><strong>Size:</strong> ${(stats.size / 1024).toFixed(2)} KB</li>
        </ul>
        <p>To restore, replace <code>data/calendar.db</code> with this file and restart the server.</p>
        <hr>
        <p style="color: #666; font-size: 12px;">
          Automated backup from Guesty Calendar App
        </p>
      `,
      text: `Weekly Database Backup\n\nDate: ${date}\nFile: ${backupFilename}\nSize: ${(stats.size / 1024).toFixed(2)} KB\n\nTo restore, replace data/calendar.db with this file and restart the server.`,
      attachments: [
        {
          filename: backupFilename,
          content: backupData.toString('base64'),
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
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('calendar_backup_') && f.endsWith('.db'))
    .sort()
    .reverse();

  for (const file of files.slice(4)) {
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
