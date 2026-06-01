/**
 * Inclusive-start / exclusive-end Jahresgrenzen für DB-Vergleiche.
 *
 * `check_in` enthält in der DB ein Zeit-Suffix (z.B. '2026-12-31T08:00:00+00:00').
 * Ein `<= '2026-12-31'`-Vergleich würde den 31.12. fälschlich ausschließen.
 * Deshalb exklusive Obergrenze = Folgejahres-Anfang, abgefragt mit `< endExclusive`.
 */
export function getYearRange(year: number): { start: string; endExclusive: string } {
  return {
    start: `${year}-01-01`,
    endExclusive: `${year + 1}-01-01`,
  };
}
