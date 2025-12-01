#!/usr/bin/env npx tsx
/**
 * Admin Script: Set Document Sequence Number
 *
 * Use this script to set the starting document number for a given year.
 * Useful when migrating from another system.
 *
 * Usage:
 *   npx tsx src/scripts/set-document-sequence.ts <year> <last_number>
 *
 * Examples:
 *   npx tsx src/scripts/set-document-sequence.ts 2025 47
 *   # Next document will be A-2025-0048 (quote) or 2025-0048 (invoice)
 *
 *   npx tsx src/scripts/set-document-sequence.ts 2025 0
 *   # Reset to start from 0001
 */

import { getDatabase, initDatabase } from '../db/index.js';

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    // Show current status
    showCurrentStatus();
    return;
  }

  if (args.length !== 2) {
    console.error('Usage: npx tsx src/scripts/set-document-sequence.ts <year> <last_number>');
    console.error('');
    console.error('Examples:');
    console.error('  npx tsx src/scripts/set-document-sequence.ts 2025 47');
    console.error('  # Next document will be A-2025-0048 (quote) or 2025-0048 (invoice)');
    console.error('');
    console.error('  npx tsx src/scripts/set-document-sequence.ts 2025 0');
    console.error('  # Reset to start from 0001');
    console.error('');
    console.error('Run without arguments to see current status.');
    process.exit(1);
  }

  const year = parseInt(args[0], 10);
  const lastNumber = parseInt(args[1], 10);

  if (isNaN(year) || year < 2020 || year > 2100) {
    console.error('Error: Year must be a valid number between 2020 and 2100');
    process.exit(1);
  }

  if (isNaN(lastNumber) || lastNumber < 0) {
    console.error('Error: Last number must be a non-negative integer');
    process.exit(1);
  }

  setSequence(year, lastNumber);
}

function showCurrentStatus() {
  console.log('Initializing database...\n');
  initDatabase();

  const db = getDatabase();
  const sequences = db.prepare('SELECT * FROM document_sequences ORDER BY year DESC').all() as Array<{
    id: number;
    sequence_type: string;
    year: number;
    last_number: number;
    updated_at: string;
  }>;

  console.log('=== Current Document Sequences ===\n');

  if (sequences.length === 0) {
    console.log('No sequences found. First document will start at 0001.');
  } else {
    for (const seq of sequences) {
      const nextNumber = seq.last_number + 1;
      const nextQuote = `A-${seq.year}-${String(nextNumber).padStart(4, '0')}`;
      const nextInvoice = `${seq.year}-${String(nextNumber).padStart(4, '0')}`;

      console.log(`Year ${seq.year}:`);
      console.log(`  Last used number: ${seq.last_number}`);
      console.log(`  Next quote:       ${nextQuote}`);
      console.log(`  Next invoice:     ${nextInvoice}`);
      console.log(`  Updated at:       ${seq.updated_at}`);
      console.log('');
    }
  }

  // Show recent documents
  const recentDocs = db.prepare(`
    SELECT document_number, document_type, created_at
    FROM documents
    ORDER BY created_at DESC
    LIMIT 5
  `).all() as Array<{
    document_number: string;
    document_type: string;
    created_at: string;
  }>;

  if (recentDocs.length > 0) {
    console.log('=== Recent Documents ===\n');
    for (const doc of recentDocs) {
      const type = doc.document_type === 'quote' ? 'Angebot' : 'Rechnung';
      console.log(`  ${doc.document_number} (${type}) - ${doc.created_at}`);
    }
    console.log('');
  }
}

function setSequence(year: number, lastNumber: number) {
  console.log('Initializing database...\n');
  initDatabase();

  const db = getDatabase();

  // Check current value
  const existing = db
    .prepare('SELECT last_number FROM document_sequences WHERE sequence_type = ? AND year = ?')
    .get('shared', year) as { last_number: number } | undefined;

  if (existing) {
    console.log(`Current last_number for ${year}: ${existing.last_number}`);
    console.log(`Setting to: ${lastNumber}`);

    db.prepare('UPDATE document_sequences SET last_number = ?, updated_at = datetime(\'now\') WHERE sequence_type = ? AND year = ?')
      .run(lastNumber, 'shared', year);
  } else {
    console.log(`No sequence exists for ${year}. Creating new entry.`);
    console.log(`Setting last_number to: ${lastNumber}`);

    db.prepare('INSERT INTO document_sequences (sequence_type, year, last_number) VALUES (?, ?, ?)')
      .run('shared', year, lastNumber);
  }

  const nextNumber = lastNumber + 1;
  const nextQuote = `A-${year}-${String(nextNumber).padStart(4, '0')}`;
  const nextInvoice = `${year}-${String(nextNumber).padStart(4, '0')}`;

  console.log('\n=== Success ===\n');
  console.log(`Next quote will be:   ${nextQuote}`);
  console.log(`Next invoice will be: ${nextInvoice}`);
}

main();
