/**
 * Report-Typen der Mail-Reports (#1223). Empfänger je Typ leben in den Tabellen
 * report_recipients / report_subscriptions (Migration 041), gepflegt unter /admin/reporting.
 */
export const REPORT_TYPES = ['weekly-summary', 'portfolio-weekly', 'portfolio-monthly', 'calendar-weekly'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** Report-Typen, die je Objekt abonniert werden (property_slug gesetzt). */
export const PER_PROPERTY_REPORT_TYPES: readonly ReportType[] = ['weekly-summary'];

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  'weekly-summary': 'Weekly Summary',
  'portfolio-weekly': 'Portfolio wöchentlich',
  'portfolio-monthly': 'Portfolio monatlich',
  'calendar-weekly': 'Kalender (Nächste Gäste)',
};

export function isReportType(value: unknown): value is ReportType {
  return typeof value === 'string' && (REPORT_TYPES as readonly string[]).includes(value);
}

export function isPerPropertyReportType(type: ReportType): boolean {
  return PER_PROPERTY_REPORT_TYPES.includes(type);
}
