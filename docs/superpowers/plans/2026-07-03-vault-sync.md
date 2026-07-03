# Vault-Sync (Server ↔ GitHub) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nach jeder Vault-Freigabe und zu Beginn jedes ETL-Laufs synct der Server den Vault mit `origin/main` (fetch → merge → push), damit Server/GitHub/Laptop nicht divergieren.

**Architecture:** Neuer Service `vault-sync.ts` mit `syncVault()` nach dem Dependency-Injection-Muster von `vault-writer.ts`. Kontrakt: wirft nie, gibt `{ synced, pushed, error? }` zurück. Zwei dünne Aufrufpunkte: `routes/suggestions.ts` (nach Freigabe, UI-Hinweis bei ausstehendem Push) und `jobs/etl-job.ts` (einmal am Anfang von `runETLJob`).

**Tech Stack:** TypeScript/Express, `execFileSync('git', …)` via argv, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-03-vault-sync-design.md`

## Global Constraints

- Git nur via `execFileSync('git', ['-C', vaultPath, ...args])` — argv, keine Shell.
- `syncVault()` wirft NIE — alle Fehler landen im Rückgabewert. Freigabe und ETL scheitern nie am Sync.
- Ohne `VAULT_PATH`: sofortiger No-op ohne git-Aufrufe, kein Fehler.
- Merge, kein Rebase; bei Merge-Fehler `git merge --abort` (Vault bleibt sauber).
- Netz-Operationen (fetch/push) mit 30-s-Timeout, damit ein hängendes git den ETL nicht blockiert.
- Abweichung von Spec-Tests 6–7: Route-/ETL-Verdrahtung bleibt ungetestet-dünn (Codebase-Konvention, kein Route-Test-Harness); das Non-fatal-Verhalten ist über den „wirft nie"-Kontrakt des Service abgedeckt (Tests 3+4).

---

### Task 1: Service `vault-sync.ts` mit Tests

**Files:**
- Create: `src/services/vault-sync.ts`
- Test: `src/services/vault-sync.test.ts`

**Interfaces:**
- Consumes: `config.vaultPath` aus `src/config/index.js` (bereits vorhanden, `string | undefined`).
- Produces: `syncVault(deps?: VaultSyncDeps): VaultSyncResult` mit
  `VaultSyncResult = { synced: boolean; pushed: boolean; error?: string }` und
  `VaultSyncDeps = { vaultPath: string | undefined; git: (args: string[]) => string }`.
  Tasks 2+3 importieren `syncVault` aus `../services/vault-sync.js` bzw. `../services/vault-sync.js`.

- [ ] **Step 1: Failing Tests schreiben**

`src/services/vault-sync.test.ts`:

```ts
// src/services/vault-sync.test.ts
import { describe, it, expect } from 'vitest';
import { syncVault, type VaultSyncDeps } from './vault-sync.js';

/** Fake-git: zeichnet Aufrufe auf; wirft für Subkommandos in `fail`. */
function fakeDeps(fail: string[] = [], vaultPath: string | undefined = '/vault') {
  const calls: string[][] = [];
  const deps: VaultSyncDeps = {
    vaultPath,
    git: (args) => {
      calls.push(args);
      if (fail.includes(args[0])) throw new Error(`${args[0]} kaputt`);
      // 'merge --abort' separat schaltbar über fail-Eintrag 'abort'
      if (args[0] === 'merge' && args[1] === '--abort' && fail.includes('abort')) {
        throw new Error('abort kaputt');
      }
      return '';
    },
  };
  return { deps, calls };
}

describe('syncVault', () => {
  it('happy path: fetch → merge → push, synced+pushed', () => {
    const { deps, calls } = fakeDeps();
    const res = syncVault(deps);
    expect(res).toEqual({ synced: true, pushed: true });
    expect(calls).toEqual([
      ['fetch', 'origin'],
      ['merge', 'origin/main', '--no-edit'],
      ['push', 'origin', 'main'],
    ]);
  });

  it('push schlägt fehl → synced true, pushed false, Fehler benannt', () => {
    const { deps } = fakeDeps(['push']);
    const res = syncVault(deps);
    expect(res.synced).toBe(true);
    expect(res.pushed).toBe(false);
    expect(res.error).toContain('push failed');
  });

  it('fetch schlägt fehl (offline) → kein merge/push versucht', () => {
    const { deps, calls } = fakeDeps(['fetch']);
    const res = syncVault(deps);
    expect(res).toMatchObject({ synced: false, pushed: false });
    expect(res.error).toContain('fetch failed');
    expect(calls).toEqual([['fetch', 'origin']]);
  });

  it('merge schlägt fehl → merge --abort wird aufgerufen, kein push', () => {
    const { deps, calls } = fakeDeps(['merge']);
    const res = syncVault(deps);
    expect(res).toMatchObject({ synced: false, pushed: false });
    expect(res.error).toContain('merge failed');
    expect(calls).toContainEqual(['merge', '--abort']);
    expect(calls.some((c) => c[0] === 'push')).toBe(false);
  });

  it('merge UND abort schlagen fehl → beide Fehler im Ergebnis, nichts geworfen', () => {
    // fakeDeps: 'merge' in fail lässt auch --abort werfen? Nein — --abort wirft nur
    // mit fail-Eintrag 'abort'. Hier beides scharf:
    const calls: string[][] = [];
    const deps: VaultSyncDeps = {
      vaultPath: '/vault',
      git: (args) => {
        calls.push(args);
        if (args[0] === 'merge') throw new Error(args[1] === '--abort' ? 'abort kaputt' : 'merge kaputt');
        return '';
      },
    };
    const res = syncVault(deps);
    expect(res).toMatchObject({ synced: false, pushed: false });
    expect(res.error).toContain('merge failed');
    expect(res.error).toContain('abort failed');
  });

  it('ohne vaultPath: No-op ohne git-Aufrufe, kein Fehler', () => {
    const { deps, calls } = fakeDeps([], undefined);
    const res = syncVault(deps);
    expect(res).toEqual({ synced: false, pushed: false });
    expect(calls).toEqual([]);
  });
});
```

Achtung Fake-Semantik: `fail.includes('merge')` lässt JEDEN merge-Aufruf werfen — auch `--abort`. Deshalb im Fake VOR dem generischen Check behandeln:

```ts
    git: (args) => {
      calls.push(args);
      if (args[0] === 'merge' && args[1] === '--abort') {
        if (fail.includes('abort')) throw new Error('abort kaputt');
        return '';
      }
      if (fail.includes(args[0])) throw new Error(`${args[0]} kaputt`);
      return '';
    },
```

(Diese Variante in den Test übernehmen — der Kommentar im 5. Test entfällt dann, dort weiter das eigene Inline-Deps-Objekt verwenden.)

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `cd ~/Development/guesty-calendar-app && npx vitest run src/services/vault-sync.test.ts`
Expected: FAIL — `Cannot find module './vault-sync.js'` (o. ä.)

- [ ] **Step 3: Implementierung**

`src/services/vault-sync.ts`:

```ts
// src/services/vault-sync.ts
import { execFileSync } from 'node:child_process';
import { config } from '../config/index.js';

export interface VaultSyncDeps {
  vaultPath: string | undefined;
  git: (args: string[]) => string;
}

export interface VaultSyncResult {
  synced: boolean;
  pushed: boolean;
  error?: string;
}

const GIT_TIMEOUT_MS = 30_000;

function defaultDeps(): VaultSyncDeps {
  const vaultPath = config.vaultPath;
  return {
    vaultPath,
    git: (args) =>
      String(execFileSync('git', ['-C', vaultPath as string, ...args], { timeout: GIT_TIMEOUT_MS })),
  };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Synct den Vault mit origin/main: fetch → merge (kein Rebase) → push.
 * Wirft NIE — Fehler landen im Rückgabewert. Ohne VAULT_PATH: No-op.
 */
export function syncVault(deps: VaultSyncDeps = defaultDeps()): VaultSyncResult {
  if (!deps.vaultPath) return { synced: false, pushed: false };

  try {
    deps.git(['fetch', 'origin']);
  } catch (err) {
    return { synced: false, pushed: false, error: `fetch failed: ${msg(err)}` };
  }

  try {
    deps.git(['merge', 'origin/main', '--no-edit']);
  } catch (mergeErr) {
    try {
      deps.git(['merge', '--abort']);
      return { synced: false, pushed: false, error: `merge failed (aborted): ${msg(mergeErr)}` };
    } catch (abortErr) {
      return {
        synced: false,
        pushed: false,
        error: `merge failed: ${msg(mergeErr)}; abort failed: ${msg(abortErr)}`,
      };
    }
  }

  try {
    deps.git(['push', 'origin', 'main']);
  } catch (err) {
    return { synced: true, pushed: false, error: `push failed: ${msg(err)}` };
  }

  return { synced: true, pushed: true };
}
```

- [ ] **Step 4: Tests laufen lassen — müssen grün sein**

Run: `npx vitest run src/services/vault-sync.test.ts`
Expected: PASS (6 Tests)

- [ ] **Step 5: Volle Suite + tsc**

Run: `npx vitest run && npx tsc --noEmit`
Expected: alle Tests grün (289 + 6), tsc clean

- [ ] **Step 6: Commit**

```bash
git add src/services/vault-sync.ts src/services/vault-sync.test.ts
git commit -m "feat: vault-sync service (fetch→merge→push, wirft nie)"
```

---

### Task 2: Sync nach Freigabe (Route-Verdrahtung + UI-Hinweis)

**Files:**
- Modify: `src/routes/suggestions.ts` (GET `/` Zeilen 15–32, POST `/:id/approve` Zeilen 34–44)

**Interfaces:**
- Consumes: `syncVault(): VaultSyncResult` aus `../services/vault-sync.js` (Task 1).
- Produces: nichts Neues für andere Tasks. Redirect-Kontrakt: bei `pushed: false` → `/admin/suggestions?push=pending`, sonst `/admin/suggestions`.

- [ ] **Step 1: Import ergänzen**

In `src/routes/suggestions.ts` nach dem `applySuggestion`-Import:

```ts
import { applySuggestion } from '../services/vault-writer.js';
import { syncVault } from '../services/vault-sync.js';
import logger from '../utils/logger.js';
```

- [ ] **Step 2: Approve-Handler erweitern**

Bestehenden Block

```ts
    markSuggestionApplied(s.id, result.commit);
    res.redirect('/admin/suggestions');
```

ersetzen durch:

```ts
    markSuggestionApplied(s.id, result.commit);
    const sync = syncVault();
    if (sync.error) logger.warn({ error: sync.error }, 'Vault-Sync nach Freigabe (non-fatal)');
    res.redirect(sync.pushed ? '/admin/suggestions' : '/admin/suggestions?push=pending');
```

- [ ] **Step 3: Hinweis im GET-Handler**

Im GET `/` die `body`-Zusammensetzung erweitern — vor `${items …}` einfügen:

```ts
  const pushNotice = req.query.push === 'pending'
    ? '<p class="subtitle">⚠️ Vault committet, Push zu GitHub ausstehend — wird beim nächsten Sync automatisch nachgeholt.</p>'
    : '';
```

und im Template `${pushNotice}` direkt nach der bestehenden `<p class="subtitle">…</p>`-Zeile einsetzen. Der GET-Handler braucht dafür `req` statt `_req` in der Signatur.

- [ ] **Step 4: Suite + tsc**

Run: `npx vitest run && npx tsc --noEmit`
Expected: grün / clean (keine neuen Tests — dünne Verdrahtung, Kontrakt in Task 1 getestet)

- [ ] **Step 5: Commit**

```bash
git add src/routes/suggestions.ts
git commit -m "feat: Vault-Push nach Freigabe (non-fatal, UI-Hinweis bei ausstehendem Push)"
```

---

### Task 3: Sync am Anfang des ETL-Laufs

**Files:**
- Modify: `src/jobs/etl-job.ts` (Funktion `runETLJob`, Zeile 328 ff.)

**Interfaces:**
- Consumes: `syncVault(): VaultSyncResult` aus `../services/vault-sync.js` (Task 1).
- Produces: nichts — Logging only, Ergebnis beeinflusst den ETL-Erfolg nicht.

- [ ] **Step 1: Import ergänzen**

In `src/jobs/etl-job.ts` bei den anderen Service-Imports:

```ts
import { syncVault } from '../services/vault-sync.js';
```

- [ ] **Step 2: Aufruf an den Anfang von `runETLJob`**

Direkt als erste Zeilen im Funktionskörper von `runETLJob` (vor `const properties = getAllProperties();`), damit ALLE Pfade (multi-property, default, legacy) abgedeckt sind:

```ts
  // Vault zuerst syncen: frisches Wissen für Draft-Gen + liegengebliebene Feedback-Commits pushen
  const vaultSync = syncVault();
  if (vaultSync.error) {
    logger.warn({ error: vaultSync.error }, '📚 Vault-Sync (non-fatal)');
  } else if (vaultSync.synced) {
    logger.info({ pushed: vaultSync.pushed }, '📚 Vault synced');
  }
```

(Ohne `VAULT_PATH` ist das ein stiller No-op — kein Log-Rauschen in Setups ohne Vault.)

- [ ] **Step 3: Suite + tsc**

Run: `npx vitest run && npx tsc --noEmit`
Expected: grün / clean

- [ ] **Step 4: Commit**

```bash
git add src/jobs/etl-job.ts
git commit -m "feat: Vault-Sync als erster ETL-Schritt (non-fatal)"
```

---

### Task 4: Deploy + Live-Verifikation + Doku

**Files:**
- Modify (anderes Repo!): `/Users/mca/Development/TheBrain/Areas/Software/Guest-Messaging-Integration.md` (Status-Zeile + Fahrplan)

**Interfaces:**
- Consumes: Deploy-Weg aus dem Runbook (`docs/vault-deployment.md`): `git pull && npm install && npm run build && pm2 restart guesty-calendar`, PATH auf nvm-v22.

- [ ] **Step 1: App-Repo pushen**

```bash
cd ~/Development/guesty-calendar-app && git push origin main
```

- [ ] **Step 2: Auf dem Server deployen**

```bash
ssh deploy@labs.remoterepublic.com 'export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"; cd /opt/guesty-calendar-app && git pull && npm install && npm run build && pm2 restart guesty-calendar'
```

(Exakten nvm-Pfad ggf. per `ssh … "ls ~/.nvm/versions/node/"` prüfen.)
Expected: pull fast-forward, build ohne Fehler, pm2 restart ok.

- [ ] **Step 3: Live-Verifikation**

Test-Divergenz erzeugen ist unnötig — es reicht der Beweis, dass der Sync im ETL läuft und der Vault clean+aktuell ist:

```bash
ssh deploy@labs.remoterepublic.com 'export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"; cd /opt/guesty-calendar-app && npm run sync 2>&1 | grep -i vault; git -C /opt/TheBrain status --short --branch'
```

Expected: Log-Zeile `📚 Vault synced` (pushed: true) und `## main...origin/main` OHNE ahead/behind.

- [ ] **Step 4: Vault-Doku aktualisieren + committen**

In `/Users/mca/Development/TheBrain/Areas/Software/Guest-Messaging-Integration.md`:
- Status-Zeile: „Offen: Vault-Commit-Push …" ersetzen durch „Offen: Guesty-Send-Zweig" und „Vault-Sync (Server↔GitHub) automatisch" als erledigt erwähnen.
- Unter `## Deployment — erledigt` einen Satz ergänzen: Vault synct jetzt automatisch (nach jeder Freigabe + stündlich im ETL: fetch → merge → push, non-fatal; Konflikt → abort + manuell).

```bash
cd ~/Development/TheBrain && git add Areas/Software/Guest-Messaging-Integration.md && git commit -m "Software: Vault-Sync Server↔GitHub automatisiert (nach Freigabe + stündlich im ETL)" && git push
```
