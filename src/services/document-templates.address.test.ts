// #883: Absenderadresse auf Angebot/Rechnung/Storno — PLZ war 16151 statt 16515.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const TEMPLATES = ['angebot.html', 'rechnung.html', 'stornorechnung.html'];
const templatesDir = path.join(process.cwd(), 'data', 'templates');

describe('Dokument-Templates: Absenderadresse (#883)', () => {
  for (const file of TEMPLATES) {
    it(`${file} nennt 16515 Oranienburg und nie 16151`, () => {
      const html = fs.readFileSync(path.join(templatesDir, file), 'utf-8');
      expect(html).not.toContain('16151');
      // Kopf, Absenderzeile über der Empfängeranschrift, Fußzeile
      expect(html.match(/16515 Oranienburg/g)).toHaveLength(3);
      expect(html).toContain('Farmhouse Prasser, Schmachtenhagener Str. 3D, 16515 Oranienburg');
    });
  }
});
