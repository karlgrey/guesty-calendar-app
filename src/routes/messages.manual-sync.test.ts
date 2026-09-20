import { describe, it, expect, vi, beforeEach } from 'vitest';

// Final-Review F2: getHostexClient() wurde bisher ZWISCHEN acquireMessageSyncLock(...)
// und dem try aufgerufen — wirft er (z. B. fehlender Hostex-Token), bleibt der Lock
// für immer belegt und Loop/ETL/manueller Button überspringen jeden weiteren Lauf.
// Fix: getHostexClient() zieht in den try-Block, damit das finally (Lock-Release)
// in jedem Fall läuft. Dieser Test ruft runMessageSync() direkt auf (exportiert für
// Tests, siehe messages.ts) statt über den asynchron feuernden POST /sync-Handler —
// der antwortet sofort mit Redirect und gibt kein Signal, wann der Hintergrundlauf
// fertig ist.

vi.mock('../services/hostex-client.js', () => ({
  getHostexClient: () => { throw new Error('HOSTEX_API_TOKEN fehlt'); },
}));

import { messageSyncLock } from '../jobs/message-loop.js';
import { runMessageSync } from './messages.js';

describe('runMessageSync — Lock-Freigabe bei Fehler vor dem try (F2)', () => {
  beforeEach(() => {
    messageSyncLock.release();
  });

  it('gibt den Lock frei, wenn getHostexClient() wirft', async () => {
    // runMessageSync() selbst fängt den Fehler nicht ab (das macht der aufrufende
    // POST /sync-Handler mit .catch) — hier zählt nur: das finally lief, Lock frei.
    await expect(runMessageSync()).rejects.toThrow('HOSTEX_API_TOKEN fehlt');
    expect(messageSyncLock.holder).toBeNull();
  });
});
