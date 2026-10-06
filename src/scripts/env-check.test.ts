import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// #797 (TheBrain2-Board): Deploys scheitern nicht mehr still an fehlenden
// Umgebungsvariablen. scripts/env-check.sh vergleicht NUR Key-Namen aus
// .env.example (Vertrag) gegen .env bzw. die Environment= der systemd-Unit.
const SCRIPT = resolve('scripts/env-check.sh');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'env-check-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('sh', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

const EXAMPLE = [
  '# Server',
  'NODE_ENV=development',
  'PORT=3000',
  '',
  '# commented-out keys are not part of the contract',
  '# SMTP_HOST=smtp.example.com',
  '# optional',
  'JUDGE_MODEL=claude-opus-5',
  '# Optional — Default 10',
  'AUTO_SEND_DAILY_CAP=10',
  '# optional',
  '',
  'NOT_OPTIONAL_BLANK_BETWEEN=x',
  '# optional',
  '# Empfänger-JID',
  'NOT_OPTIONAL_COMMENT_BETWEEN=x',
  'SESSION_SECRET=your_session_secret_here',
  '',
].join('\n');

const FULL_ENV = [
  'NODE_ENV=production',
  'export PORT=3005',
  'JUDGE_MODEL=claude-opus-5',
  'AUTO_SEND_DAILY_CAP=5',
  'NOT_OPTIONAL_BLANK_BETWEEN=1',
  'NOT_OPTIONAL_COMMENT_BETWEEN=1',
  'SESSION_SECRET=SUPERSECRET-value-must-never-leak',
  '',
].join('\n');

describe('scripts/env-check.sh — Datei-Modus', () => {
  it('alle Pflicht-Keys vorhanden → Exit 0', () => {
    const r = run([file('.env.example', EXAMPLE), file('.env', FULL_ENV)]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('✓');
  });

  it('fehlender Key → Exit 1, nennt genau diesen Key und den Pfad der Ziel-Datei', () => {
    const env = file('.env', FULL_ENV.replace(/^NODE_ENV=.*\n/m, ''));
    const r = run([file('.env.example', EXAMPLE), env]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^\s+- NODE_ENV$/m);
    expect(r.out).not.toMatch(/^\s+- PORT$/m);
    expect(r.out).toContain(`Wert in ${resolve(env)} eintragen (deploy-Fenster), dann erneut deployen`);
  });

  it('leerer Wert zählt als vorhanden (nur Namen werden verglichen)', () => {
    const r = run([file('.env.example', EXAMPLE), file('.env', FULL_ENV.replace('NODE_ENV=production', 'NODE_ENV='))]);
    expect(r.code).toBe(0);
  });

  it('optionaler Key (Marker "# optional" direkt darüber) fehlt → kein Abbruch, nur Hinweis', () => {
    const env = FULL_ENV.replace(/^JUDGE_MODEL=.*\n/m, '').replace(/^AUTO_SEND_DAILY_CAP=.*\n/m, '');
    const r = run([file('.env.example', EXAMPLE), file('.env', env)]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/optional.*JUDGE_MODEL/);
    expect(r.out).toMatch(/optional.*AUTO_SEND_DAILY_CAP/);
  });

  it('Marker gilt nur für die unmittelbar folgende Zeile (Leer- oder Kommentarzeile dazwischen → Pflicht)', () => {
    const env = FULL_ENV.replace(/^NOT_OPTIONAL_BLANK_BETWEEN=.*\n/m, '').replace(
      /^NOT_OPTIONAL_COMMENT_BETWEEN=.*\n/m,
      '',
    );
    const r = run([file('.env.example', EXAMPLE), file('.env', env)]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^\s+- NOT_OPTIONAL_BLANK_BETWEEN$/m);
    expect(r.out).toMatch(/^\s+- NOT_OPTIONAL_COMMENT_BETWEEN$/m);
  });

  it('Zusatz-Keys in .env → kein Abbruch, nur Hinweis', () => {
    const r = run([file('.env.example', EXAMPLE), file('.env', FULL_ENV + 'HOSTEX_ACCESS_TOKEN=abc\n')]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Hinweis.*HOSTEX_ACCESS_TOKEN/);
  });

  it('auskommentierte Keys im Vertrag sind keine Pflicht, auskommentierte Keys in .env zählen nicht', () => {
    const r1 = run([file('.env.example', EXAMPLE), file('.env', FULL_ENV)]);
    expect(r1.out).not.toContain('SMTP_HOST');
    const env = FULL_ENV.replace('NODE_ENV=production', '# NODE_ENV=production');
    const r2 = run([file('.env.example', EXAMPLE), file('.env', env)]);
    expect(r2.code).toBe(1);
    expect(r2.out).toMatch(/^\s+- NODE_ENV$/m);
  });

  it('gibt nie Werte aus — weder aus .env noch aus dem Vertrag', () => {
    const env = FULL_ENV.replace(/^PORT=.*\n/m, '').replace('export PORT=3005\n', '') + 'EXTRA=EXTRASECRET\n';
    const r = run([file('.env.example', EXAMPLE), file('.env', env)]);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('SUPERSECRET');
    expect(r.out).not.toContain('EXTRASECRET');
    expect(r.out).not.toContain('your_session_secret_here');
    expect(r.out).not.toContain('production');
  });

  it('.env fehlt → Exit 1 mit allen Pflicht-Keys', () => {
    const r = run([file('.env.example', EXAMPLE), join(dir, 'gibt-es-nicht.env')]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^\s+- NODE_ENV$/m);
    expect(r.out).toMatch(/^\s+- SESSION_SECRET$/m);
  });

  it('Vertrag fehlt oder falscher Aufruf → Exit 2', () => {
    expect(run([join(dir, 'nope.example'), file('.env', FULL_ENV)]).code).toBe(2);
    expect(run([]).code).toBe(2);
    expect(run([file('.env.example', EXAMPLE)]).code).toBe(2);
  });
});

describe('scripts/env-check.sh — systemd-Modus', () => {
  // Fake-systemctl: protokolliert die Argumente und liefert eine Environment=-Zeile
  // im Format von `systemctl show -p Environment --value` (Werte mit Leerzeichen in "").
  function fakeSystemctl(envLine: string): { bin: string; argsLog: string } {
    const argsLog = join(dir, 'args.log');
    const bin = file('systemctl', `#!/bin/sh\necho "$@" > '${argsLog}'\ncat <<'X'\n${envLine}\nX\n`);
    chmodSync(bin, 0o755);
    return { bin, argsLog };
  }

  const SD_EXAMPLE = 'NODE_ENV=production\nPORT=3020\nORIGIN=https://example.org\n# optional\nBODY_SIZE_LIMIT=10M\n';

  it('liest Environment= der Unit, alle Keys da → Exit 0', () => {
    const { bin, argsLog } = fakeSystemctl(
      'PATH=/usr/bin NODE_ENV=production PORT=3020 "ORIGIN=https://x.example SUPERSECRET"',
    );
    const r = run([file('.env.example', SD_EXAMPLE), '--systemd', 'smarttasks.service'], { SYSTEMCTL: bin });
    expect(r.code).toBe(0);
    expect(readFileSync(argsLog, 'utf8').trim()).toBe('show smarttasks.service -p Environment --value');
    expect(r.out).toMatch(/optional.*BODY_SIZE_LIMIT/);
    expect(r.out).not.toContain('SUPERSECRET');
  });

  it('fehlender Key → Exit 1 mit Hinweis auf die Unit; "KEY=" innerhalb eines Werts zählt nicht', () => {
    const { bin } = fakeSystemctl('NODE_ENV=production "X=a ORIGIN=b"');
    const r = run([file('.env.example', SD_EXAMPLE), '--systemd', 'smarttasks.service'], { SYSTEMCTL: bin });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^\s+- PORT$/m);
    expect(r.out).toMatch(/^\s+- ORIGIN$/m);
    expect(r.out).toContain('smarttasks.service');
    expect(r.out).toContain('daemon-reload');
  });

  it('systemctl scheitert → Exit 2 (kein stilles Durchwinken)', () => {
    const bin = file('systemctl', '#!/bin/sh\nexit 1\n');
    chmodSync(bin, 0o755);
    const r = run([file('.env.example', SD_EXAMPLE), '--systemd', 'smarttasks.service'], { SYSTEMCTL: bin });
    expect(r.code).toBe(2);
  });
});

describe('Vertrag des Repos', () => {
  it('.env.example ist mit dem Skript lesbar und gegen sich selbst vollständig', () => {
    const out = execFileSync('sh', [SCRIPT, '.env.example', '.env.example'], { encoding: 'utf8' });
    expect(out).toContain('✓');
  });
});

describe('deploy.sh ruft den Env-Check auf (#797)', () => {
  it('nach git pull (neuer Vertrag) und vor npm ci / build / pm2 restart', () => {
    const lines = readFileSync('deploy.sh', 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    const idx = (re: RegExp) => lines.findIndex((l) => re.test(l));
    const check = idx(/^sh scripts\/env-check\.sh \.env\.example \.env$/);
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(idx(/^git pull --ff-only/));
    expect(check).toBeLessThan(idx(/^npm ci/));
    expect(check).toBeLessThan(idx(/^npm run build/));
    expect(check).toBeLessThan(idx(/^pm2 restart/));
  });
});
