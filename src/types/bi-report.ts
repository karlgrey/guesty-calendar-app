/**
 * Shared data model for the portfolio BI email. Built by `bi-email.ts`,
 * rendered by `bi-email-templates.ts`.
 */
import type { GanttGrid } from '../services/bi-calendar.js';
import type { RevenueForecast, ForecastConfidence } from '../services/forecast.js';

export interface PropertyKpi {
  slug: string;
  name: string;
  occupancy6wk: number;      // %
  occupancy30d: number;      // %
  revenueYtd: number;
  revenueMonth: number;
  revenueChangePct: number;  // vs previous month
  bookingsYtd: number;
  adr: number;               // avg daily rate (YTD revenue / booked nights)
  currency: string;
}

export interface UpcomingArrival {
  date: string;        // YYYY-MM-DD (check_in)
  propertySlug: string;
  propertyName: string;
  guestName: string;
  nights: number;
  guests: number;
  source: string;
  isTurnover: boolean; // same-day checkout+checkin at this property
}

export interface PropertyForecast {
  slug: string;
  name: string;
  committedTotal: number;
  expectedTotal: number;
  highTotal: number;
  confidence: ForecastConfidence;
  methodLabel: string; // e.g. "Vorjahr", "überw. Vorjahr", "Buchungsvorlauf", "Ramp-up (Anlauf)"
  months: RevenueForecast[];
}

export interface BiReportModel {
  generatedAt: string;   // ISO timestamp
  weekLabel: string;     // e.g. "2. Jun 2026"
  currency: string;
  portfolio: {
    revenueYtd: number;
    avgOccupancy6wk: number;
    bookingsYtd: number;
    committedRevenueHorizon: number; // committed € over forecast horizon
  };
  calendar: GanttGrid;
  arrivals: UpcomingArrival[];
  kpis: PropertyKpi[];
  portfolioForecast: RevenueForecast[];
  propertyForecasts: PropertyForecast[];
}
