/**
 * Analytics Repository
 *
 * Database operations for GA4 analytics data.
 */

import { getDatabase } from '../db/index.js';
import type { DailyAnalytics, TopPage, RegionData } from '../services/ga4-client.js';

/**
 * Analytics record from database
 */
export interface AnalyticsRecord {
  id: number;
  date: string;
  pageviews: number;
  users: number;
  sessions: number;
  avg_session_duration: number;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * Top page record from database
 */
export interface TopPageRecord {
  id: number;
  date: string;
  page_path: string;
  page_title: string | null;
  pageviews: number;
  rank: number;
  created_at: string;
}

/**
 * Analytics summary from database
 */
export interface AnalyticsSummary {
  totalPageviews: number;
  totalUsers: number;
  totalSessions: number;
  avgSessionDuration: number;
  daysWithData: number;
}

/**
 * Upsert daily analytics data
 */
export function upsertDailyAnalytics(data: DailyAnalytics): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO analytics (date, pageviews, users, sessions, avg_session_duration, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      pageviews = excluded.pageviews,
      users = excluded.users,
      sessions = excluded.sessions,
      avg_session_duration = excluded.avg_session_duration,
      last_synced_at = excluded.last_synced_at
  `).run(data.date, data.pageviews, data.users, data.sessions, data.avgSessionDuration, now);
}

/**
 * Upsert multiple daily analytics records
 */
export function upsertDailyAnalyticsBatch(dataList: DailyAnalytics[]): number {
  const db = getDatabase();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO analytics (date, pageviews, users, sessions, avg_session_duration, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      pageviews = excluded.pageviews,
      users = excluded.users,
      sessions = excluded.sessions,
      avg_session_duration = excluded.avg_session_duration,
      last_synced_at = excluded.last_synced_at
  `);

  const transaction = db.transaction(() => {
    let count = 0;
    for (const data of dataList) {
      stmt.run(data.date, data.pageviews, data.users, data.sessions, data.avgSessionDuration, now);
      count++;
    }
    return count;
  });

  return transaction();
}

/**
 * Replace top pages for a specific date
 */
export function replaceTopPages(date: string, pages: TopPage[]): void {
  const db = getDatabase();

  const deleteStmt = db.prepare('DELETE FROM analytics_top_pages WHERE date = ?');
  const insertStmt = db.prepare(`
    INSERT INTO analytics_top_pages (date, page_path, page_title, pageviews, rank)
    VALUES (?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    deleteStmt.run(date);
    pages.forEach((page, index) => {
      insertStmt.run(date, page.pagePath, page.pageTitle, page.pageviews, index + 1);
    });
  });

  transaction();
}

/**
 * Log a sync operation
 */
export function logSync(
  dateRangeStart: string,
  dateRangeEnd: string,
  recordsSynced: number,
  success: boolean,
  errorMessage?: string
): void {
  const db = getDatabase();

  db.prepare(`
    INSERT INTO analytics_sync_log (date_range_start, date_range_end, records_synced, success, error_message)
    VALUES (?, ?, ?, ?, ?)
  `).run(dateRangeStart, dateRangeEnd, recordsSynced, success ? 1 : 0, errorMessage || null);
}

/**
 * Get analytics summary for the last N days
 */
export function getAnalyticsSummary(days: number = 30): AnalyticsSummary {
  const db = getDatabase();

  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString().split('T')[0];

  const result = db.prepare(`
    SELECT
      COALESCE(SUM(pageviews), 0) as total_pageviews,
      COALESCE(SUM(users), 0) as total_users,
      COALESCE(SUM(sessions), 0) as total_sessions,
      COALESCE(AVG(avg_session_duration), 0) as avg_session_duration,
      COUNT(*) as days_with_data
    FROM analytics
    WHERE date BETWEEN ? AND ?
  `).get(startDateStr, endDate) as {
    total_pageviews: number;
    total_users: number;
    total_sessions: number;
    avg_session_duration: number;
    days_with_data: number;
  };

  return {
    totalPageviews: result.total_pageviews,
    totalUsers: result.total_users,
    totalSessions: result.total_sessions,
    avgSessionDuration: result.avg_session_duration,
    daysWithData: result.days_with_data,
  };
}

/**
 * Get daily analytics data for the last N days
 */
export function getDailyAnalytics(days: number = 30): AnalyticsRecord[] {
  const db = getDatabase();

  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString().split('T')[0];

  return db.prepare(`
    SELECT * FROM analytics
    WHERE date BETWEEN ? AND ?
    ORDER BY date DESC
  `).all(startDateStr, endDate) as AnalyticsRecord[];
}

/**
 * Get the most recent top pages
 */
export function getLatestTopPages(): TopPageRecord[] {
  const db = getDatabase();

  // Get the most recent date with top pages data
  const latestDate = db.prepare(`
    SELECT date FROM analytics_top_pages ORDER BY date DESC LIMIT 1
  `).get() as { date: string } | undefined;

  if (!latestDate) {
    return [];
  }

  return db.prepare(`
    SELECT * FROM analytics_top_pages
    WHERE date = ?
    ORDER BY rank ASC
  `).all(latestDate.date) as TopPageRecord[];
}

/**
 * Get the last successful sync timestamp
 */
export function getLastSyncTime(): string | null {
  const db = getDatabase();

  const result = db.prepare(`
    SELECT synced_at FROM analytics_sync_log
    WHERE success = 1
    ORDER BY synced_at DESC
    LIMIT 1
  `).get() as { synced_at: string } | undefined;

  return result?.synced_at || null;
}

/**
 * Check if analytics data exists
 */
export function hasAnalyticsData(): boolean {
  const db = getDatabase();

  const result = db.prepare('SELECT COUNT(*) as count FROM analytics').get() as { count: number };
  return result.count > 0;
}

/**
 * Get analytics data for a specific date range (for charts)
 */
export function getAnalyticsRange(startDate: string, endDate: string): AnalyticsRecord[] {
  const db = getDatabase();

  return db.prepare(`
    SELECT * FROM analytics
    WHERE date BETWEEN ? AND ?
    ORDER BY date ASC
  `).all(startDate, endDate) as AnalyticsRecord[];
}

/**
 * Monthly comparison data
 */
export interface MonthlyComparison {
  currentMonth: {
    pageviews: number;
    users: number;
    sessions: number;
    label: string;
  };
  previousMonth: {
    pageviews: number;
    users: number;
    sessions: number;
    label: string;
  };
  change: {
    pageviews: number;
    users: number;
    sessions: number;
  };
}

/**
 * Get analytics comparison: last 30 days vs 30 days before that
 */
export function getMonthlyAnalyticsComparison(): MonthlyComparison {
  const db = getDatabase();
  const today = new Date();

  // Last 30 days
  const last30End = today;
  const last30Start = new Date(today);
  last30Start.setDate(last30Start.getDate() - 29); // 30 days including today

  // 30 days before that
  const prev30End = new Date(last30Start);
  prev30End.setDate(prev30End.getDate() - 1);
  const prev30Start = new Date(prev30End);
  prev30Start.setDate(prev30Start.getDate() - 29);

  const formatDate = (d: Date) => d.toISOString().split('T')[0];

  const currentResult = db.prepare(`
    SELECT
      COALESCE(SUM(pageviews), 0) as pageviews,
      COALESCE(SUM(users), 0) as users,
      COALESCE(SUM(sessions), 0) as sessions
    FROM analytics
    WHERE date BETWEEN ? AND ?
  `).get(formatDate(last30Start), formatDate(last30End)) as {
    pageviews: number;
    users: number;
    sessions: number;
  };

  const prevResult = db.prepare(`
    SELECT
      COALESCE(SUM(pageviews), 0) as pageviews,
      COALESCE(SUM(users), 0) as users,
      COALESCE(SUM(sessions), 0) as sessions
    FROM analytics
    WHERE date BETWEEN ? AND ?
  `).get(formatDate(prev30Start), formatDate(prev30End)) as {
    pageviews: number;
    users: number;
    sessions: number;
  };

  // Calculate percentage change
  const calcChange = (current: number, previous: number): number => {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 100);
  };

  return {
    currentMonth: {
      pageviews: currentResult.pageviews,
      users: currentResult.users,
      sessions: currentResult.sessions,
      label: 'Last 30 Days',
    },
    previousMonth: {
      pageviews: prevResult.pageviews,
      users: prevResult.users,
      sessions: prevResult.sessions,
      label: 'Previous 30 Days',
    },
    change: {
      pageviews: calcChange(currentResult.pageviews, prevResult.pageviews),
      users: calcChange(currentResult.users, prevResult.users),
      sessions: calcChange(currentResult.sessions, prevResult.sessions),
    },
  };
}

/**
 * Region record from database
 */
export interface RegionRecord {
  id: number;
  date: string;
  region: string;
  users: number;
  sessions: number;
  created_at: string;
}

/**
 * Replace regions for a specific date
 */
export function replaceRegions(date: string, regions: RegionData[]): void {
  const db = getDatabase();

  const deleteStmt = db.prepare('DELETE FROM analytics_regions WHERE date = ?');
  const insertStmt = db.prepare(`
    INSERT INTO analytics_regions (date, region, users, sessions)
    VALUES (?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    deleteStmt.run(date);
    for (const region of regions) {
      insertStmt.run(date, region.region, region.users, region.sessions);
    }
  });

  transaction();
}

/**
 * Get top regions for the last N days (aggregated)
 */
export function getTopRegions(days: number = 30): { region: string; users: number; sessions: number }[] {
  const db = getDatabase();

  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString().split('T')[0];

  return db.prepare(`
    SELECT
      region,
      SUM(users) as users,
      SUM(sessions) as sessions
    FROM analytics_regions
    WHERE date BETWEEN ? AND ?
    GROUP BY region
    ORDER BY users DESC
    LIMIT 10
  `).all(startDateStr, endDate) as { region: string; users: number; sessions: number }[];
}
