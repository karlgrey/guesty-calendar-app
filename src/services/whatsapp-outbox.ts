/**
 * WhatsApp-Outbox-Writer (#793). Die Bridge (TheBrain2 #766) liest JSON-Dateien
 * `{"chatJid": "...", "text": "..."}` aus ihrem Outbox-Verzeichnis, sendet nur an
 * Whitelist-Chats und verschiebt nach done/ bzw. failed/. Die App ist reiner
 * Schreiber: atomar (erst .tmp, dann rename), Verzeichnis wird NIE angelegt
 * (falscher Pfad soll laut scheitern statt stumm ins Leere zu schreiben).
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @returns absoluter Pfad der geschriebenen Datei.
 * @param tag  Reservierungs-ID (wird im Dateinamen auf die letzten 8 Zeichen gekürzt)
 * @param unixTs  nur für Tests
 */
export function writeOutboxMessage(
  dir: string,
  chatJid: string,
  text: string,
  tag = 'msg',
  unixTs: number = Math.floor(Date.now() / 1000),
): string {
  if (!fs.statSync(dir).isDirectory()) throw new Error(`Outbox-Pfad ist kein Verzeichnis: ${dir}`);
  const short = tag.replace(/[^A-Za-z0-9]/g, '').slice(-8) || 'msg';
  const base = `${unixTs}-guesty-app-${short}`;

  let final = path.join(dir, `${base}.json`);
  for (let n = 2; fs.existsSync(final); n++) final = path.join(dir, `${base}-${n}.json`);

  const tmp = `${final}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ chatJid, text }), { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(tmp, final);
  return final;
}
