/**
 * Zählerstand-Annahme (#1169): Home Assistant schickt den fortlaufenden kWh-Stand eines
 * Objekts. Die App holt nichts ab (HA ist nur über Tailscale erreichbar).
 *
 *   POST /api/meter/readings
 *   Authorization: Bearer <METER_INGEST_TOKEN>
 *   Content-Type: application/json
 *   {"slug": "farmhouse", "kwh": 12345.678, "measuredAt": "2026-11-19T10:00:00+01:00"}
 *
 * - 201 {ok, stored: true,  slug, measuredAt (UTC), kwh} — neu gespeichert
 * - 200 {ok, stored: false, duplicate: true, …}           — Zeitpunkt schon vorhanden (erster Wert bleibt)
 * - 400 ungültiger Körper · 401 Token fehlt/falsch · 404 Objekt unbekannt · 503 Token nicht konfiguriert
 *
 * Das Token schaltet ausschließlich diesen Endpunkt frei (eigener Router unter /api/meter,
 * vor dem globalen express.json() gemountet); Agent-Keys gelten hier nicht.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';
import { getPropertyBySlug } from '../config/properties.js';
import { insertMeterReading } from '../repositories/meter-reading-repository.js';
import logger from '../utils/logger.js';

const router = express.Router();

/** Messzeitpunkte dürfen höchstens so weit in der Zukunft liegen (Uhrenabweichung HA ↔ Server). */
export const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;
/** ISO 8601 mit Datum, Uhrzeit und Zeitzone (Z oder ±HH:MM). */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const NUMERIC_STRING = /^\d+(\.\d+)?$/;
const ALLOWED_FIELDS = ['slug', 'kwh', 'measuredAt'];

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireMeterToken(req: Request, res: Response, next: NextFunction): void {
  const expected = config.meterIngestToken;
  if (!expected) {
    res.status(503).json({ error: 'Meter ingest is not configured' });
    return;
  }
  const match = /^Bearer\s+(.+)$/i.exec(req.header('Authorization') ?? '');
  if (!match || !tokenMatches(match[1].trim(), expected)) {
    logger.warn({ path: req.path, ip: req.ip }, 'Meter ingest: invalid or missing token');
    res.status(401).json({ error: 'Invalid meter token' });
    return;
  }
  next();
}

interface ValidReading { slug: string; kwh: number; measuredAtUtc: string }

function validate(body: unknown, now: number): { ok: true; value: ValidReading } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'JSON-Objekt erwartet' };
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !ALLOWED_FIELDS.includes(k));
  if (unknown.length) return { ok: false, error: `Unbekannte Felder: ${unknown.join(', ')} (erlaubt: ${ALLOWED_FIELDS.join(', ')})` };
  if (typeof b.slug !== 'string' || !b.slug.trim()) return { ok: false, error: 'slug fehlt' };

  let kwh: number;
  if (typeof b.kwh === 'number') kwh = b.kwh;
  else if (typeof b.kwh === 'string' && NUMERIC_STRING.test(b.kwh.trim())) kwh = Number(b.kwh.trim());
  else return { ok: false, error: 'kwh muss eine Zahl sein' };
  if (!Number.isFinite(kwh) || kwh < 0) return { ok: false, error: 'kwh muss eine endliche Zahl ≥ 0 sein' };

  if (typeof b.measuredAt !== 'string' || !ISO_WITH_ZONE.test(b.measuredAt.trim())) {
    return { ok: false, error: 'measuredAt muss ISO 8601 mit Zeitzone sein, z. B. 2026-11-19T10:00:00+01:00' };
  }
  const t = Date.parse(b.measuredAt.trim());
  if (!Number.isFinite(t)) return { ok: false, error: 'measuredAt ist kein gültiger Zeitpunkt' };
  if (t > now + MAX_FUTURE_SKEW_MS) return { ok: false, error: 'measuredAt liegt in der Zukunft' };

  return { ok: true, value: { slug: b.slug.trim(), kwh, measuredAtUtc: new Date(t).toISOString() } };
}

router.use(requireMeterToken);
router.use(express.json({ limit: '10kb' }));
// JSON-Parse-Fehler dieses Routers als 400 (der globale Error-Handler machte daraus 500).
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err && typeof err === 'object' && (err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Ungültiges JSON' });
    return;
  }
  next(err);
});

router.post('/readings', (req, res) => {
  const result = validate(req.body, Date.now());
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  const { slug, kwh, measuredAtUtc } = result.value;
  if (!getPropertyBySlug(slug)) {
    res.status(404).json({ error: `Objekt ${slug} ist nicht konfiguriert` });
    return;
  }
  const stored = insertMeterReading(slug, measuredAtUtc, kwh);
  if (!stored) {
    res.status(200).json({ ok: true, stored: false, duplicate: true, slug, measuredAt: measuredAtUtc, kwh });
    return;
  }
  logger.debug({ propertySlug: slug, measuredAt: measuredAtUtc, kwh }, 'Meter reading stored');
  res.status(201).json({ ok: true, stored: true, slug, measuredAt: measuredAtUtc, kwh });
});

export default router;
