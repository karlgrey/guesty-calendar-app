/**
 * Portfolio BI email renderer. Email-safe HTML (tables + inline styles only).
 */
import type { BiReportModel, PropertyKpi, UpcomingArrival } from '../types/bi-report.js';
import type { DayState, GanttGrid } from './bi-calendar.js';
import type { MonthForecast } from './forecast.js';

const COLORS: Record<DayState, string> = {
  booked: '#e07a5f',
  free: '#e8eae6',
  turnover: '#3d5a80',
};

function eur(n: number): string {
  return `${Math.round(n).toLocaleString('de-DE')} €`;
}

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

/** Escape data-derived strings (guest names, sources, property names) for HTML. */
function h(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function deltaCell(changePct: number): string {
  const color = changePct >= 0 ? '#3d8b5f' : '#c0573f';
  const sign = changePct >= 0 ? '+' : '−';
  return `<span style="color:${color}">${sign}${Math.abs(changePct)}%</span>`;
}

function renderCalendar(cal: GanttGrid): string {
  const labelCells = cal.labels
    .map((l) => `<td colspan="7" style="font:600 10px sans-serif;color:#888;padding:2px 0">${l.label}</td>`)
    .join('');
  const rows = cal.rows
    .map((row) => {
      const cells = row.days
        .map((d) => `<td style="width:13px;height:18px;border:1px solid #fff;background:${COLORS[d]}"></td>`)
        .join('');
      return `<tr><td style="font:600 11px sans-serif;padding:3px 8px 3px 0;white-space:nowrap">${h(row.name)}</td>${cells}</tr>`;
    })
    .join('');
  return `
    <table style="border-collapse:collapse">
      <tr><td></td>${labelCells}</tr>
      ${rows}
    </table>
    <p style="font:11px sans-serif;color:#555;margin:8px 0 0">
      <span style="display:inline-block;width:11px;height:11px;background:${COLORS.booked};vertical-align:middle"></span> belegt
      <span style="display:inline-block;width:11px;height:11px;background:${COLORS.free};vertical-align:middle;margin-left:12px"></span> frei
      <span style="display:inline-block;width:11px;height:11px;background:${COLORS.turnover};vertical-align:middle;margin-left:12px"></span> Turnover
    </p>`;
}

function renderArrivals(arrivals: UpcomingArrival[]): string {
  if (arrivals.length === 0) return '<p style="font:13px sans-serif;color:#888">Keine anstehenden Anreisen.</p>';
  const rows = arrivals
    .map((a) => {
      const turn = a.isTurnover
        ? ' <span style="background:#3d5a80;color:#fff;font:600 9px sans-serif;padding:1px 5px;border-radius:8px">Turnover</span>'
        : '';
      return `<tr>
        <td style="padding:5px 10px;font:600 12px sans-serif;border-bottom:1px solid #eee">${a.date}</td>
        <td style="padding:5px 10px;font:12px sans-serif;border-bottom:1px solid #eee">${h(a.propertyName)}${turn}</td>
        <td style="padding:5px 10px;font:12px sans-serif;border-bottom:1px solid #eee">${h(a.guestName)}</td>
        <td style="padding:5px 10px;font:12px sans-serif;border-bottom:1px solid #eee;text-align:right">${a.nights} N · ${a.guests} P</td>
        <td style="padding:5px 10px;font:12px sans-serif;border-bottom:1px solid #eee">${h(a.source)}</td>
      </tr>`;
    })
    .join('');
  return `<table style="border-collapse:collapse;width:100%"><tbody>${rows}</tbody></table>`;
}

function renderKpiTable(kpis: PropertyKpi[], portfolio: BiReportModel['portfolio']): string {
  const th = (t: string) =>
    `<th style="font:600 11px sans-serif;color:#888;padding:6px 8px;border-bottom:2px solid #ddd;text-align:right">${t}</th>`;
  const td = (t: string, align = 'right') =>
    `<td style="font:12px sans-serif;padding:6px 8px;border-bottom:1px solid #eee;text-align:${align}">${t}</td>`;
  const body = kpis
    .map(
      (k) => `<tr>
        ${td(h(k.name), 'left')}${td(pct(k.occupancy6wk))}${td(pct(k.occupancy30d))}
        ${td(eur(k.revenueYtd))}${td(eur(k.revenueMonth))}${td(deltaCell(k.revenueChangePct))}
        ${td(String(k.bookingsYtd))}${td(eur(k.adr))}
      </tr>`
    )
    .join('');
  const total = `<tr style="background:#f7f8f6;font-weight:700">
      ${td('Portfolio', 'left')}${td(pct(portfolio.avgOccupancy6wk))}${td('')}
      ${td(eur(portfolio.revenueYtd))}${td('')}${td('')}${td(String(portfolio.bookingsYtd))}${td('')}
    </tr>`;
  return `<table style="border-collapse:collapse;width:100%">
      <tr><th style="text-align:left;font:600 11px sans-serif;color:#888;padding:6px 8px;border-bottom:2px solid #ddd">Property</th>
        ${th('Bel. 6Wo')}${th('Bel. 30Tg')}${th('Umsatz YTD')}${th('Umsatz Monat')}${th('Δ Vormon.')}${th('Buch. YTD')}${th('ADR')}</tr>
      ${body}${total}
    </table>`;
}

function renderForecastBars(months: MonthForecast[]): string {
  const bars = months
    .map((m) => {
      const committedH = Math.round(m.committedPct * 1.4);
      const pickupH = Math.round(Math.max(0, m.projectedFinalPct - m.committedPct) * 1.4);
      return `<td style="vertical-align:bottom;text-align:center;padding:0 4px">
        <div style="font:9px sans-serif;color:#666">${pct(m.projectedFinalPct)}</div>
        <div style="display:inline-block;width:40px;background:#e8eae6">
          <div style="height:${pickupH}px;background:#f2c4b6"></div>
          <div style="height:${committedH}px;background:#e07a5f"></div>
        </div>
        <div style="font:600 11px sans-serif;margin-top:4px">${m.monthLabel}</div>
        <div style="font:9px sans-serif;color:#999">±${m.bandPct}%</div>
      </td>`;
    })
    .join('');
  return `<table style="border-collapse:collapse"><tr>${bars}</tr></table>`;
}

function renderPropertyForecasts(forecasts: BiReportModel['propertyForecasts']): string {
  return forecasts
    .map((f) => {
      const flag = f.lowData
        ? ' <span style="font:600 9px sans-serif;color:#b4543a">(dünne Datenbasis)</span>'
        : '';
      return `<div style="margin-top:14px">
        <div style="font:600 12px sans-serif;margin-bottom:4px">${h(f.name)}${flag}</div>
        ${renderForecastBars(f.months)}
      </div>`;
    })
    .join('');
}

export function generateBiReportEmail(model: BiReportModel): { html: string; text: string } {
  const stat = (value: string, label: string) =>
    `<td style="background:#f7f8f6;padding:12px;text-align:center">
      <div style="font:700 16px sans-serif">${value}</div>
      <div style="font:10px sans-serif;color:#888">${label}</div>
    </td>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="margin:0;background:#fff">
    <div style="max-width:680px;margin:0 auto;border:1px solid #e2e4df;border-radius:10px;overflow:hidden">
      <div style="background:#2f3a33;color:#fff;padding:16px 18px">
        <div style="font:700 16px sans-serif">📊 Portfolio-Report · ${model.weekLabel}</div>
        <div style="font:11px sans-serif;opacity:.7;margin-top:2px">${model.kpis.length} Properties</div>
      </div>
      <table style="border-collapse:separate;border-spacing:1px;width:100%"><tr>
        ${stat(eur(model.portfolio.revenueYtd), 'Umsatz YTD')}
        ${stat(pct(model.portfolio.avgOccupancy6wk), 'Ø Belegung 6 Wo')}
        ${stat(String(model.portfolio.bookingsYtd), 'Buchungen YTD')}
        ${stat(eur(model.portfolio.committedRevenueHorizon), 'fest gebucht')}
      </tr></table>
      <div style="padding:16px 18px">
        <h3 style="font:700 13px sans-serif;margin:0 0 10px">① Übersichtskalender · 6 Wochen</h3>
        ${renderCalendar(model.calendar)}
      </div>
      <div style="padding:0 18px 16px">
        <h3 style="font:700 13px sans-serif;margin:0 0 10px">② Nächste Anreisen &amp; Turnovers</h3>
        ${renderArrivals(model.arrivals)}
      </div>
      <div style="padding:0 18px 16px">
        <h3 style="font:700 13px sans-serif;margin:0 0 10px">③ Kennzahlen pro Property</h3>
        ${renderKpiTable(model.kpis, model.portfolio)}
      </div>
      <div style="padding:0 18px 18px">
        <h3 style="font:700 13px sans-serif;margin:0 0 10px">④ Forecast · 6 Monate</h3>
        <div style="font:11px sans-serif;color:#888;margin-bottom:6px">Portfolio (fest gebucht + Pickup-Hochrechnung):</div>
        ${renderForecastBars(model.portfolioForecast)}
        ${renderPropertyForecasts(model.propertyForecasts)}
      </div>
      <div style="background:#f7f8f6;padding:10px 18px;font:10px sans-serif;color:#999;text-align:center">
        Remote Republic · automatischer Portfolio-Report
      </div>
    </div>
    </body></html>`;

  const textLines = [
    `Portfolio-Report · ${model.weekLabel}`,
    `Umsatz YTD: ${eur(model.portfolio.revenueYtd)} · Ø Belegung 6Wo: ${pct(model.portfolio.avgOccupancy6wk)} · Buchungen YTD: ${model.portfolio.bookingsYtd} · fest gebucht: ${eur(model.portfolio.committedRevenueHorizon)}`,
    '',
    'Kennzahlen:',
    ...model.kpis.map(
      (k) => `  ${k.name}: Bel ${pct(k.occupancy6wk)}/${pct(k.occupancy30d)}, Umsatz YTD ${eur(k.revenueYtd)} (Monat ${eur(k.revenueMonth)}, ${k.revenueChangePct >= 0 ? '+' : ''}${k.revenueChangePct}%), Buchungen ${k.bookingsYtd}, ADR ${eur(k.adr)}`
    ),
    '',
    'Nächste Anreisen:',
    ...model.arrivals.map(
      (a) => `  ${a.date} ${a.propertyName} — ${a.guestName} (${a.nights}N/${a.guests}P, ${a.source})${a.isTurnover ? ' [Turnover]' : ''}`
    ),
    '',
    'Forecast (Portfolio):',
    ...model.portfolioForecast.map(
      (m) => `  ${m.monthLabel}: ${pct(m.committedPct)} fest → ${pct(m.projectedFinalPct)} erwartet (±${m.bandPct}%)`
    ),
  ];

  return { html, text: textLines.join('\n') };
}
