// #793: Outbox-Writer für die WhatsApp-Bridge — nur Temp-Verzeichnisse, nie das echte Outbox.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeOutboxMessage } from './whatsapp-outbox.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-outbox-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('writeOutboxMessage', () => {
  it('schreibt {chatJid,text} als JSON, Dateiname <ts>-guesty-app-<kurz>.json, kein .tmp übrig', () => {
    const file = writeOutboxMessage(dir, '380509566925@s.whatsapp.net', 'Hallo Wanja', '686d1e927ae7af00234115ad', 1790000000);
    expect(path.basename(file)).toBe('1790000000-guesty-app-234115ad.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ chatJid: '380509566925@s.whatsapp.net', text: 'Hallo Wanja' });
    expect(fs.readdirSync(dir)).toEqual([path.basename(file)]);
  });

  it('Kollision (gleiche Sekunde, gleiche Reservierung) überschreibt nicht', () => {
    const a = writeOutboxMessage(dir, 'j@s.whatsapp.net', 'eins', 'abcdef1234567890', 1790000000);
    const b = writeOutboxMessage(dir, 'j@s.whatsapp.net', 'zwei', 'abcdef1234567890', 1790000000);
    expect(a).not.toBe(b);
    expect(JSON.parse(fs.readFileSync(a, 'utf8')).text).toBe('eins');
    expect(JSON.parse(fs.readFileSync(b, 'utf8')).text).toBe('zwei');
  });

  it('Umlaute/Sonderzeichen bleiben erhalten', () => {
    const f = writeOutboxMessage(dir, 'j@s.whatsapp.net', 'Check-out 18:00 – Reinigung nach Späti', 'x1', 1);
    expect(JSON.parse(fs.readFileSync(f, 'utf8')).text).toBe('Check-out 18:00 – Reinigung nach Späti');
  });

  it('nicht existierendes Verzeichnis -> Fehler, es wird nichts angelegt', () => {
    const missing = path.join(dir, 'nope');
    expect(() => writeOutboxMessage(missing, 'j@s.whatsapp.net', 't', 'x')).toThrow();
    expect(fs.existsSync(missing)).toBe(false);
  });
});
