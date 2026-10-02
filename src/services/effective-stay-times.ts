/**
 * Effektive An-/Abreisezeit eines Aufenthalts (#799) — PURE, kein I/O.
 *
 * Reihenfolge je Zeit: Override (unsere DB) vor Provider-Feld (`planned_*`) vor
 * Listing-Standard. Ohne alles: null.
 */
import type { StayTimeOverride } from '../repositories/stay-time-override-repository.js';

export type TimeSource = 'override' | 'provider' | 'default' | null;

export interface EffectiveTimes {
  effectiveArrival: string | null;
  effectiveDeparture: string | null;
  arrivalSource: TimeSource;
  departureSource: TimeSource;
  providerArrival: string | null;
  providerDeparture: string | null;
  defaultArrival: string | null;
  defaultDeparture: string | null;
}

const hhmm = (t: string | null | undefined): string | null => (t ? t.slice(0, 5) : null);

function pick(override: string | null, provider: string | null, def: string | null): [string | null, TimeSource] {
  if (override) return [override, 'override'];
  if (provider) return [provider, 'provider'];
  if (def) return [def, 'default'];
  return [null, null];
}

export function effectiveTimes(
  reservation: { planned_arrival: string | null; planned_departure: string | null },
  override: Pick<StayTimeOverride, 'plannedArrival' | 'plannedDeparture'> | null,
  listingDefaults: { checkIn: string | null; checkOut: string | null } | null,
): EffectiveTimes {
  const providerArrival = hhmm(reservation.planned_arrival);
  const providerDeparture = hhmm(reservation.planned_departure);
  const defaultArrival = hhmm(listingDefaults?.checkIn);
  const defaultDeparture = hhmm(listingDefaults?.checkOut);
  const [effectiveArrival, arrivalSource] = pick(hhmm(override?.plannedArrival), providerArrival, defaultArrival);
  const [effectiveDeparture, departureSource] = pick(hhmm(override?.plannedDeparture), providerDeparture, defaultDeparture);
  return {
    effectiveArrival, effectiveDeparture, arrivalSource, departureSource,
    providerArrival, providerDeparture, defaultArrival, defaultDeparture,
  };
}
