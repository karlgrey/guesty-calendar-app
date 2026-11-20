/**
 * #1299 Preise und Mindestnächte je Datumsbereich über die Agent-API.
 *
 *   GET /api/agent/pricing/:slug?from=&to=   → je Tag {date, price, minNights, occupied, …}
 *   PUT /api/agent/pricing/:slug             → Body {from, to, price?|factor?, minNights?, weekdays?, dryRun?, caller?}
 *                                              oder {basePrice, dryRun?, caller?} (#1305, nur Guesty: Grundpreis des Listings)
 *
 * Gilt für provider=guesty (Farmhouse, U19) und provider=hostex (Bootshaus, Schilderwerkstatt).
 * Eingehängt in agent-api.ts (hinter requireAgentKey). Planlogik: services/pricing-plan.ts,
 * Anbieter-Adapter: services/pricing-service.ts.
 */

import express from 'express';
import { getListingId, getPropertyBySlug, getPropertySlugs, type PropertyConfig } from '../config/properties.js';
import { config } from '../config/index.js';
import { berlinCalendarDay } from '../services/auto-send/berlin-day.js';
import {
  addDays, isBasePriceBody, parseBasePriceRequest, parsePricingRequest, planPricingChanges, validatePricingRange,
  type PricingChange, type PricingDay,
} from '../services/pricing-plan.js';
import {
  GUESTY_MAX_RUNS_PER_CALL, findNotApplied, planWriteRuns, readPricingDays, resolvePricingTarget, writePricingChanges,
  type PricingTarget, type WrittenRun,
} from '../services/pricing-service.js';
import { guestyClient } from '../services/guesty-client.js';
import { syncListing } from '../jobs/sync-listing.js';
import { triggerPropertyCalendarRefresh } from '../services/property-calendar-refresh.js';
import { AppError, ExternalApiError, NotFoundError, ValidationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Wartezeiten vor dem Nachlesen (ms). Guesty schreibt synchron; Hostex verarbeitet
 * asynchron (Live-Probe 20.11.2026: nach ≤ 6 s sichtbar). Für Tests überschreibbar.
 */
export const pricingVerifyDelays: { guesty: number[]; hostex: number[] } = {
  guesty: [0],
  hostex: [3000, 3000, 4000],
};

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

function handleError(res: express.Response, err: unknown) {
  if (err instanceof AppError) {
    if (err instanceof ExternalApiError && err.details !== undefined) {
      logger.warn({ err, details: err.details }, 'Agent pricing: external API error');
      return res.status(err.statusCode).json({ error: err.message, details: err.details });
    }
    return res.status(err.statusCode).json({ error: err.message });
  }
  logger.error({ err }, 'Agent pricing: unexpected error');
  return res.status(500).json({ error: 'Internal error' });
}

function requireProperty(slug: string) {
  const property = getPropertyBySlug(slug);
  if (!property) throw new NotFoundError(`Unbekanntes property: ${slug} (erlaubt: ${getPropertySlugs().join('|')})`);
  return property;
}

function summary(target: PricingTarget) {
  return {
    slug: target.property.slug, name: target.property.name, provider: target.provider,
    listingId: target.listingId,
    ...(target.channel ? { channel: target.channel } : {}),
    currency: target.property.currency ?? 'EUR',
  };
}

/** Aufrufer fürs Änderungslog: Body `caller` bzw. Header `X-Agent-Caller`, dazu die Key-Nummer (nie der Key). */
function callerOf(req: express.Request, bodyCaller?: string): string {
  const provided = req.header('X-Agent-Key') ?? '';
  const idx = config.agentApiKeySet.indexOf(provided);
  const header = req.header('X-Agent-Caller')?.trim().slice(0, 100);
  const name = bodyCaller ?? (header || 'agent-api');
  return idx >= 0 ? `${name} (key #${idx + 1})` : name;
}

function today(): string {
  return berlinCalendarDay(new Date().toISOString());
}

router.get('/pricing/:slug', async (req, res) => {
  try {
    const property = requireProperty(req.params.slug);
    const todayBerlin = today();
    const fromRaw = typeof req.query.from === 'string' && req.query.from !== '' ? req.query.from : todayBerlin;
    const toRaw = typeof req.query.to === 'string' && req.query.to !== '' ? req.query.to : addDays(fromRaw, 365);
    const { from, to } = validatePricingRange(fromRaw, toRaw);
    const target = await resolvePricingTarget(property);
    const days = await readPricingDays(target, from, to, todayBerlin);
    res.json({
      property: summary(target), provider: target.provider, from, to,
      days: days.map((d) => ({
        date: d.date, price: d.price, minNights: d.minNights, occupied: d.occupied,
        ...(d.occupiedReason ? { occupiedReason: d.occupiedReason } : {}),
        closedOnArrival: d.closedOnArrival, closedOnDeparture: d.closedOnDeparture,
      })),
    });
  } catch (err) { handleError(res, err); }
});

/** Verschiedene Altwerte eines Laufs fürs Log (kompakt statt je Tag). */
function oldValues(changes: PricingChange[], run: WrittenRun, field: 'price' | 'minNights'): Array<number | null> {
  const vals = changes.filter((c) => c.date >= run.from && c.date <= run.to && c[field]).map((c) => c[field]!.old);
  return [...new Set(vals)];
}

/** Grundpreis aus Guesty Financials (oberste Ebene, Zahl); fehlt er, null. */
function basePriceOf(financials: unknown): number | null {
  const v = (financials as { basePrice?: unknown } | null | undefined)?.basePrice;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const BASE_PRICE_NOTE = 'Grundpreis des Listings (Guesty Financials). Tagespreise im Kalender haben Vorrang; '
  + 'bestehende Tageswerte werden nicht verändert, nur Tage ohne eigenen Preis folgen dem Grundpreis';

/**
 * #1305: Grundpreis eines Guesty-Listings setzen. Allein im Aufruf (ohne from/to/Tageswerte).
 * dryRun liest den Ist-Wert frisch von Guesty (GET /financials/listing/{id}). Vollzug: PUT Financials
 * {basePrice}, Nachlesen, Änderungslog, danach Listing-Cache (syncListing force) und Kalender-Refresh.
 */
async function putBasePrice(req: express.Request, res: express.Response, property: PropertyConfig): Promise<void> {
  const request = parseBasePriceRequest(req.body);
  if (property.provider !== 'guesty') {
    throw new ValidationError(`basePrice nur für provider=guesty (Objekt ${property.slug}: ${property.provider})`);
  }
  const listingId = getListingId(property);
  const caller = callerOf(req, request.caller);
  const target: PricingTarget = { property, provider: 'guesty', listingId };

  const financials = await guestyClient.getListingFinancials(listingId);
  const old = basePriceOf(financials);
  const weekend = (financials as { weekendBasePrice?: unknown } | null)?.weekendBasePrice;
  const base = {
    property: summary(target), provider: target.provider,
    requested: { basePrice: request.basePrice },
    dryRun: request.dryRun,
    basePrice: { old, new: request.basePrice },
    unchanged: old === request.basePrice,
    ...(typeof weekend === 'number' && weekend > 0 ? { weekendBasePrice: weekend } : {}),
    note: BASE_PRICE_NOTE,
  };

  if (request.dryRun) {
    logger.info({ slug: property.slug, basePrice: base.basePrice, caller }, 'Agent pricing base price dry run');
    res.json(base);
    return;
  }
  if (base.unchanged) {
    // Nichts zu schreiben, aber der Listing-Cache kann veraltet sein (Änderung direkt in Guesty, TTL 24 h).
    const sync = await syncListing(listingId, true);
    res.json({ ...base, applied: true, written: false, current: old, listingCacheRefreshed: sync.success, calendarSync: 'nicht nötig' });
    return;
  }

  await guestyClient.updateListingBasePrice(listingId, request.basePrice);
  logger.info({ slug: property.slug, provider: target.provider, listingId, basePrice: base.basePrice, caller }, 'Agent pricing base price change');

  // Ab hier ist geschrieben: Fehler beim Nachlesen machen die Antwort nicht zum Fehler.
  let current: number | null = null;
  let verifyError: string | undefined;
  try {
    current = basePriceOf(await guestyClient.getListingFinancials(listingId));
  } catch (err) {
    verifyError = err instanceof Error ? err.message : String(err);
    logger.warn({ slug: property.slug, listingId, err }, 'Base price written, but re-reading Guesty failed');
  }
  const sync = await syncListing(listingId, true);
  const calendarSync = triggerPropertyCalendarRefresh(property, listingId);
  res.json({
    ...base,
    applied: true,
    written: true,
    current,
    ...(verifyError !== undefined ? { verifyFailed: true, verifyError } : {}),
    ...(verifyError === undefined && current !== request.basePrice
      ? { notApplied: true, notAppliedNote: 'Guesty zeigt noch einen anderen Grundpreis, mit dryRun prüfen' }
      : {}),
    listingCacheRefreshed: sync.success,
    calendarSync,
  });
}

router.put('/pricing/:slug', async (req, res) => {
  try {
    const property = requireProperty(req.params.slug);
    if (isBasePriceBody(req.body)) {
      await putBasePrice(req, res, property);
      return;
    }
    const todayBerlin = today();
    const request = parsePricingRequest(req.body, todayBerlin);
    const target = await resolvePricingTarget(property);
    if (target.provider === 'hostex' && request.price !== undefined && !Number.isInteger(request.price)) {
      throw new ValidationError(`Hostex nimmt nur ganze Euro (price ${request.price})`);
    }
    const caller = callerOf(req, request.caller);

    const before = await readPricingDays(target, request.from, request.to, todayBerlin);
    const plan = planPricingChanges(before, request, todayBerlin);
    const runs = planWriteRuns(target, plan.changes);
    const maxRuns = target.provider === 'guesty' ? GUESTY_MAX_RUNS_PER_CALL : null;
    const exceedsMaxRuns = maxRuns !== null && runs.length > maxRuns;
    const base = {
      property: summary(target), provider: target.provider,
      from: request.from, to: request.to,
      ...(request.weekdays ? { weekdays: request.weekdays } : {}),
      requested: {
        ...(request.price !== undefined ? { price: request.price } : {}),
        ...(request.factor !== undefined ? { factor: request.factor } : {}),
        ...(request.minNights !== undefined ? { minNights: request.minNights } : {}),
      },
      dryRun: request.dryRun,
      selectedDays: plan.selectedDays,
      changedDays: plan.changes.length,
      changes: plan.changes,
      unchanged: plan.unchanged,
      skipped: plan.skipped,
    };

    if (request.dryRun) {
      logger.info({ slug: property.slug, from: request.from, to: request.to, changedDays: plan.changes.length, caller }, 'Agent pricing dry run');
      res.json({ ...base, runs, maxRuns, exceedsMaxRuns });
      return;
    }
    if (exceedsMaxRuns) {
      // #1304: nicht selbst teilen (factor ist nicht wiederholbar), nichts schreiben.
      logger.warn({ slug: property.slug, from: request.from, to: request.to, runs: runs.length, maxRuns, caller }, 'Agent pricing rejected: too many runs');
      res.status(400).json({
        error: `Zu viele Schreibläufe für Guesty: ${runs.length} (maximal ${maxRuns} je Aufruf). `
          + 'Zeitraum teilen und nacheinander aufrufen (vorher mit dryRun die Zahl der runs prüfen); geschrieben wurde nichts',
        runs: runs.length,
        maxRuns,
      });
      return;
    }
    if (plan.changes.length === 0) {
      res.json({ ...base, applied: true, written: [], calendarSync: 'nicht nötig' });
      return;
    }

    const outcome = await writePricingChanges(target, plan.changes, before);
    for (const run of outcome.written) {
      logger.info({
        slug: property.slug, provider: target.provider, from: run.from, to: run.to, nights: run.nights,
        ...(run.price !== undefined ? { price: { old: oldValues(plan.changes, run, 'price'), new: run.price } } : {}),
        ...(run.minNights !== undefined ? { minNights: { old: oldValues(plan.changes, run, 'minNights'), new: run.minNights } } : {}),
        caller,
      }, 'Agent pricing change');
    }
    if (outcome.error !== undefined) {
      const e = outcome.error;
      const calendarSync = outcome.written.length > 0
        ? triggerPropertyCalendarRefresh(property, target.listingId)
        : 'nicht nötig';
      logger.warn({ slug: property.slug, err: e, written: outcome.written.length, caller }, 'Agent pricing write failed (partial)');
      res.status(502).json({
        ...base,
        applied: false,
        error: e instanceof Error ? e.message : String(e),
        ...(e instanceof AppError && e.details !== undefined ? { details: e.details } : {}),
        written: outcome.written,
        note: 'Abgebrochen: die Läufe in written hat der Anbieter angenommen; der fehlgeschlagene Aufruf kann trotzdem teilweise gewirkt haben. '
          + 'Vor einem neuen Aufruf GET /pricing prüfen, einen Aufruf mit factor nie ungeprüft wiederholen (er rechnet auf den dann aktuellen Preis)',
        calendarSync,
      });
      return;
    }

    // Nachlesen: steht ein Tag noch im alten Zustand, melden (nicht fatal; Hostex asynchron).
    let notApplied: string[] = plan.changes.map((c) => c.date);
    let verifyError: string | undefined;
    for (const delay of pricingVerifyDelays[target.provider]) {
      await sleep(delay);
      try {
        const after: PricingDay[] = await readPricingDays(target, request.from, request.to, todayBerlin);
        notApplied = findNotApplied(plan.changes, after);
        verifyError = undefined;
      } catch (err) {
        verifyError = err instanceof Error ? err.message : String(err);
      }
      if (verifyError === undefined && notApplied.length === 0) break;
    }
    // Refresh erst NACH dem Nachlesen: Hostex verarbeitet asynchron, ein sofortiger Sync
    // spiegelte sonst noch den alten Preis in den Cache (dann bis zum nächsten Stunden-ETL).
    const calendarSync = triggerPropertyCalendarRefresh(property, target.listingId);

    res.json({
      ...base,
      applied: true,
      written: outcome.written,
      ...(verifyError !== undefined ? { verifyFailed: true, verifyError } : {}),
      ...(verifyError === undefined && notApplied.length > 0
        ? { notApplied, note: target.provider === 'hostex'
          ? 'Hostex verarbeitet asynchron — diese Tage zeigen noch den alten Wert, GET /pricing später prüfen'
          : 'Guesty zeigt diese Tage noch im alten Zustand — GET /pricing prüfen' }
        : {}),
      calendarSync,
    });
  } catch (err) { handleError(res, err); }
});

export default router;
