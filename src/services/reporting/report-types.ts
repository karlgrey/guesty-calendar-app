/**
 * Report-Typen der Mail-Reports (#1223). Empfänger je Typ leben in den Tabellen
 * report_recipients / report_subscriptions (Migration 041), gepflegt unter /admin/reporting.
 * Der CHECK-Constraint auf report_type steht seit Migration 047 (#1376) in der Tabelle
 * (neu aufgebaut, um `power-stay` zu erlauben) — neue Typen brauchen wieder eine Migration.
 */
export const REPORT_TYPES = ['weekly-summary', 'portfolio-weekly', 'portfolio-monthly', 'calendar-weekly', 'power-stay'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** Report-Typen, die je Objekt abonniert werden (property_slug gesetzt). calendar-weekly seit #1284, power-stay seit #1376. */
export const PER_PROPERTY_REPORT_TYPES: readonly ReportType[] = ['weekly-summary', 'calendar-weekly', 'power-stay'];

/**
 * Objekt-Typen, die nur für bestimmte Objekte gelten (kein Eintrag = alle Objekte).
 * power-stay: nur das Farmhouse hat einen Stromzähler (#1169/#1376).
 */
export const REPORT_TYPE_PROPERTY_SLUGS: Partial<Record<ReportType, readonly string[]>> = {
  'power-stay': ['farmhouse'],
};

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  'weekly-summary': 'Weekly Summary',
  'portfolio-weekly': 'Portfolio wöchentlich',
  'portfolio-monthly': 'Portfolio monatlich',
  'calendar-weekly': 'Kalender (Nächste Gäste)',
  'power-stay': 'Strom je Gast',
};

export function isReportType(value: unknown): value is ReportType {
  return typeof value === 'string' && (REPORT_TYPES as readonly string[]).includes(value);
}

export function isPerPropertyReportType(type: ReportType): boolean {
  return PER_PROPERTY_REPORT_TYPES.includes(type);
}

/** true, wenn der Report-Typ für das Objekt abonniert werden kann (kein Eintrag = alle Objekte). */
export function reportTypeAppliesTo(type: ReportType, slug: string): boolean {
  const slugs = REPORT_TYPE_PROPERTY_SLUGS[type];
  return !slugs || slugs.includes(slug);
}
