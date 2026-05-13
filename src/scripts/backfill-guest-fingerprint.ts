/**
 * Backfill Guest Fingerprint
 *
 * Computes internal_guest_id and guest_company for existing reservations
 * where they are still NULL (or for all rows if --force is passed).
 *
 * Usage:
 *   npx tsx src/scripts/backfill-guest-fingerprint.ts --dry-run
 *   npx tsx src/scripts/backfill-guest-fingerprint.ts --apply
 *   npx tsx src/scripts/backfill-guest-fingerprint.ts --apply --force
 *
 * Safe to re-run: without --force it only touches rows with NULL fingerprint.
 */

import { initDatabase } from '../db/index.js';
import { fingerprintGuest } from '../utils/guest-fingerprint.js';
import logger from '../utils/logger.js';

interface Row {
  id: number;
  reservation_id: string;
  guest_name: string | null;
  internal_guest_id: string | null;
  guest_company: string | null;
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const apply = args.includes('--apply');
  const force = args.includes('--force');

  if (!dryRun && !apply) {
    console.error('Usage: backfill-guest-fingerprint.ts --dry-run | --apply [--force]');
    process.exit(1);
  }

  const db = initDatabase();

  const where = force ? '' : 'WHERE internal_guest_id IS NULL';
  const rows = db
    .prepare(
      `SELECT id, reservation_id, guest_name, internal_guest_id, guest_company
       FROM reservations
       ${where}
       ORDER BY id ASC`
    )
    .all() as Row[];

  console.log(`Found ${rows.length} reservations to process (force=${force})`);
  console.log('');

  const update = db.prepare(
    `UPDATE reservations
     SET internal_guest_id = ?, guest_company = ?
     WHERE id = ?`
  );

  let changed = 0;
  for (const row of rows) {
    const fp = fingerprintGuest(row.guest_name);
    const willChange =
      fp.id !== row.internal_guest_id || fp.company !== row.guest_company;

    const status = willChange ? 'CHANGE' : 'same';
    console.log(
      `[${status}] #${row.id}  "${row.guest_name ?? '(null)'}"  →  id="${fp.id ?? '(null)'}"  company="${fp.company ?? '(null)'}"`
    );

    if (apply && willChange) {
      update.run(fp.id, fp.company, row.id);
      changed++;
    }
  }

  console.log('');
  if (dryRun) {
    const wouldChange = rows.filter((r) => {
      const f = fingerprintGuest(r.guest_name);
      return f.id !== r.internal_guest_id || f.company !== r.guest_company;
    }).length;
    console.log(`DRY-RUN: would update ${wouldChange} rows. No write performed.`);
  } else {
    console.log(`APPLIED: updated ${changed} rows.`);
  }
}

try {
  main();
} catch (error) {
  logger.error({ error }, 'Backfill failed');
  process.exit(1);
}
