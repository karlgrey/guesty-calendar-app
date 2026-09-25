/**
 * Hostex Owner-Blocks (#725) — reine Gruppierungsfunktion für aufeinander-
 * folgende gesperrte Kalendertage (`available: false`) zu Bereichen.
 *
 * Erwartet eine chronologisch sortierte, lückenlose Tagesliste (so liefert
 * sie GET /v3/availabilities — ein Eintrag je Kalendertag im angefragten
 * Zeitraum); Gruppierung erfolgt rein über Nachbarschaft im Array, nicht
 * über Datumsarithmetik.
 */

export interface AvailabilityDay {
  date: string; // "YYYY-MM-DD"
  available: boolean;
  remarks?: string;
}

export interface BlockedRange {
  from: string;
  to: string;
  nights: number;
  remarks: string;
}

/**
 * Gruppiert aufeinanderfolgende Tage mit `available === false` zu Bereichen.
 * `remarks` je Bereich stammt vom ersten Tag der Gruppe (fehlt es, leerer
 * String statt undefined). `nights` zählt die gesperrten Kalendertage im
 * Bereich (`from`/`to` beide inklusive).
 */
export function groupBlockedRanges(days: AvailabilityDay[]): BlockedRange[] {
  const ranges: BlockedRange[] = [];
  let current: BlockedRange | null = null;

  for (const day of days) {
    if (!day.available) {
      if (current) {
        current.to = day.date;
        current.nights += 1;
      } else {
        current = { from: day.date, to: day.date, nights: 1, remarks: day.remarks ?? '' };
      }
    } else if (current) {
      ranges.push(current);
      current = null;
    }
  }
  if (current) ranges.push(current);
  return ranges;
}
