/**
 * Portfolio BI email renderer. Email-safe HTML (tables + inline styles only).
 */
import type { BiReportModel, PropertyKpi, UpcomingArrival } from '../types/bi-report.js';
import type { DayState, GanttGrid } from './bi-calendar.js';
import type { RevenueForecast } from './forecast.js';

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

/** Format an ISO date (YYYY-MM-DD) as German DD.MM.YYYY. */
function deDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
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
        <td style="padding:5px 10px;font:600 12px sans-serif;border-bottom:1px solid #eee">${deDate(a.date)}</td>
        <td style="padding:5px 10px;font:12px sans-serif;border-bottom:1px solid #eee">${h(a.propertyName)}${turn}</td>
        <td style="padding:5px 10px;font:12px sans-serif;border-bottom:1px solid #eee">${h(a.guestName)}</td>
        <td style="padding:5px 10px;font:12px sans-serif;border-bottom:1px solid #eee;text-align:right">${a.nights} N · ${a.guests} P</td>
        <td style="padding:5px 10px;font:12px sans-serif;border-bottom:1px solid #eee">${h(a.source)}</td>
      </tr>`;
    })
    .join('');
  return `<table style="border-collapse:collapse;width:100%"><tbody>${rows}</tbody></table>`;
}

function renderKpiTable(kpis: PropertyKpi[], portfolio: BiReportModel['portfolio'], year: number): string {
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
        ${th('Bel. 6Wo')}${th('Bel. 30Tg')}${th(`Umsatz ${year}`)}${th('Umsatz Monat')}${th('Δ Vormon.')}${th(`Buch. ${year}`)}${th('ADR')}</tr>
      ${body}${total}
    </table>`;
}

const CONF_BADGE: Record<RevenueForecast['confidence'], string> = {
  hoch: 'background:#d8ece0;color:#2f7a52',
  mittel: 'background:#fbeecc;color:#9a7b1e',
  niedrig: 'background:#eee;color:#888',
};

function confBadge(c: RevenueForecast['confidence']): string {
  return `<span style="font:600 10px sans-serif;padding:1px 7px;border-radius:9px;${CONF_BADGE[c]}">${c}</span>`;
}

// Email-safe horizontal range bar: a single-row table of coloured segments
// (no position:absolute — many mail clients drop it). Tones read left→right:
// fest gebucht (dark) → erwartet-Zuwachs (mittel) → bis optimistisch (hell) → Rest (Spur).
function rangeBar(m: RevenueForecast, scaleMax: number): string {
  const max = scaleMax > 0 ? scaleMax : 1;
  const fst = Math.max(0, Math.min(100, Math.round((m.committedRevenue / max) * 100)));
  const exp = Math.max(fst, Math.min(100, Math.round((m.expectedRevenue / max) * 100)));
  const high = Math.max(exp, Math.min(100, Math.round((m.highRevenue / max) * 100)));
  const seg = (w: number, color: string) =>
    w > 0
      ? `<td width="${w}%" bgcolor="${color}" style="width:${w}%;height:12px;font-size:0;line-height:0;background:${color}">&nbsp;</td>`
      : '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;table-layout:fixed">
      <tr style="height:12px">${seg(fst, '#e07a5f')}${seg(exp - fst, '#ef9f86')}${seg(high - exp, '#f7d8cd')}${seg(100 - high, '#eef0ec')}</tr>
    </table>`;
}

function renderForecastTable(months: RevenueForecast[]): string {
  const scaleMax = Math.max(1, ...months.map((m) => m.highRevenue));
  const td = (t: string, align = 'right') =>
    `<td style="font:12px sans-serif;padding:6px 9px;border-bottom:1px solid #eee;text-align:${align}">${t}</td>`;
  const rows = months
    .map((m) => {
      if (m.isOpen) {
        return `<tr>${td(m.monthLabel, 'left')}<td colspan="4" style="font:italic 11px sans-serif;color:#aaa;padding:6px 9px;border-bottom:1px solid #eee">noch offen — kaum Buchungen, keine belastbare Hochrechnung</td>${td(confBadge(m.confidence))}</tr>`;
      }
      return `<tr>
        ${td(m.monthLabel, 'left')}${td(eur(m.committedRevenue))}${td(eur(m.expectedRevenue))}${td(eur(m.highRevenue))}
        <td style="padding:6px 9px;border-bottom:1px solid #eee;width:30%">${rangeBar(m, scaleMax)}</td>
        ${td(confBadge(m.confidence))}
      </tr>`;
    })
    .join('');
  const sumC = months.reduce((s, m) => s + m.committedRevenue, 0);
  const sumE = months.reduce((s, m) => s + m.expectedRevenue, 0);
  const sumH = months.reduce((s, m) => s + m.highRevenue, 0);
  const total = `<tr style="background:#f7f8f6;font-weight:700">
      ${td('Σ 6 Mon', 'left')}${td(eur(sumC))}${td(eur(sumE))}${td(eur(sumH))}${td('')}${td('')}</tr>`;
  const th = (t: string, align = 'right') =>
    `<th style="font:600 11px sans-serif;color:#888;padding:6px 9px;border-bottom:2px solid #ddd;text-align:${align}">${t}</th>`;
  return `<table style="border-collapse:collapse;width:100%">
      <tr>${th('Monat', 'left')}${th('fest')}${th('erwartet')}${th('opt.')}${th('Spanne', 'left')}${th('Konfidenz')}</tr>
      ${rows}${total}
    </table>`;
}

function renderForecastByProperty(forecasts: BiReportModel['propertyForecasts']): string {
  const td = (t: string, align = 'right') =>
    `<td style="font:12px sans-serif;padding:6px 9px;border-bottom:1px solid #eee;text-align:${align}">${t}</td>`;
  const th = (t: string, align = 'right') =>
    `<th style="font:600 11px sans-serif;color:#888;padding:6px 9px;border-bottom:2px solid #ddd;text-align:${align}">${t}</th>`;
  const rows = forecasts
    .map((f) => `<tr>
      ${td(h(f.name), 'left')}${td(eur(f.committedTotal))}${td(eur(f.expectedTotal))}${td(eur(f.highTotal))}
      ${td(h(f.methodLabel), 'left')}${td(confBadge(f.confidence))}
    </tr>`)
    .join('');
  return `<table style="border-collapse:collapse;width:100%">
      <tr>${th('Property', 'left')}${th('fest')}${th('erwartet')}${th('opt.')}${th('Methode', 'left')}${th('Konfidenz')}</tr>
      ${rows}
    </table>`;
}

export function generateBiReportEmail(model: BiReportModel): { html: string; text: string } {
  const year = new Date(model.generatedAt).getFullYear();
  const propertyNames = model.kpis.map((k) => h(k.name)).join(', ');
  const stat = (value: string, label: string) =>
    `<td style="background:#f7f8f6;padding:12px;text-align:center">
      <div style="font:700 16px sans-serif">${value}</div>
      <div style="font:10px sans-serif;color:#888">${label}</div>
    </td>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="margin:0;background:#fff">
    <div style="max-width:680px;margin:0 auto;border:1px solid #e2e4df;border-radius:10px;overflow:hidden">
      <div style="background:#2f3a33;color:#fff;padding:16px 18px">
        <div style="font:700 16px sans-serif">📊 AirBnB Portfolio Report · ${model.weekLabel}</div>
        <div style="font:11px sans-serif;opacity:.7;margin-top:2px">${model.kpis.length} Properties: ${propertyNames}</div>
      </div>
      <table style="border-collapse:separate;border-spacing:1px;width:100%"><tr>
        ${stat(eur(model.portfolio.revenueYtd), `Umsatz ${year}`)}
        ${stat(pct(model.portfolio.avgOccupancy6wk), 'Ø Belegung 6 Wo')}
        ${stat(String(model.portfolio.bookingsYtd), `Buchungen ${year}`)}
        ${stat(eur(model.portfolio.committedRevenueHorizon), 'fest gebucht')}
      </tr></table>
      <div style="padding:8px 18px 0;font:10px sans-serif;color:#999">
        „Umsatz ${year}" = gesamtes Kalenderjahr ${year} inkl. bereits gebuchter zukünftiger Aufenthalte (nicht nur bis heute). „fest gebucht" = bestätigter Umsatz der kommenden Monate.
      </div>
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
        ${renderKpiTable(model.kpis, model.portfolio, year)}
      </div>
      <div style="padding:0 18px 18px">
        <h3 style="font:700 13px sans-serif;margin:0 0 10px">④ Forecast · 6 Monate (Umsatz)</h3>
        <div style="background:#f7f8f6;border-left:3px solid #e07a5f;padding:8px 12px;font:11px sans-serif;color:#555;border-radius:0 6px 6px 0;margin:0 0 12px">
          <strong>So entsteht die Prognose:</strong> „fest" = bereits bestätigte Buchungen. „erwartet" nutzt —
          wenn genug Historie vorliegt — die Vorjahreswerte (auf dieses Jahr hochgerechnet), sonst den typischen
          Buchungsvorlauf; neue Inserate über eine Ramp-up-Annahme. Die Spanne zeigt konservativ → optimistisch.
          <em>Die Konfidenz steigt, je mehr Buchungshistorie vorliegt.</em>
        </div>
        ${renderForecastTable(model.portfolioForecast)}
        <p style="font:11px sans-serif;color:#666;margin:8px 0 0">
          <span style="display:inline-block;width:11px;height:11px;background:#e07a5f;vertical-align:middle"></span> fest gebucht
          <span style="display:inline-block;width:11px;height:11px;background:#ef9f86;vertical-align:middle;margin-left:14px"></span> erwartet
          <span style="display:inline-block;width:11px;height:11px;background:#f7d8cd;vertical-align:middle;margin-left:14px"></span> bis optimistisch
        </p>
        <div style="font:600 11px sans-serif;color:#888;margin:16px 0 6px">Pro Property · Σ kommende 6 Monate</div>
        ${renderForecastByProperty(model.propertyForecasts)}
      </div>
      <div style="background:#f7f8f6;padding:10px 18px;font:10px sans-serif;color:#999;text-align:center">
        Remote Republic · automatischer Portfolio-Report
      </div>
    </div>
    </body></html>`;

  const textLines = [
    `AirBnB Portfolio Report · ${model.weekLabel}`,
    `${model.kpis.length} Properties: ${model.kpis.map((k) => k.name).join(', ')}`,
    `Umsatz ${year} (ganzes Kalenderjahr inkl. gebuchter Zukunft): ${eur(model.portfolio.revenueYtd)} · Ø Belegung 6Wo: ${pct(model.portfolio.avgOccupancy6wk)} · Buchungen ${year}: ${model.portfolio.bookingsYtd} · fest gebucht: ${eur(model.portfolio.committedRevenueHorizon)}`,
    '',
    'Kennzahlen:',
    ...model.kpis.map(
      (k) => `  ${k.name}: Bel ${pct(k.occupancy6wk)}/${pct(k.occupancy30d)}, Umsatz ${year} ${eur(k.revenueYtd)} (Monat ${eur(k.revenueMonth)}, ${k.revenueChangePct >= 0 ? '+' : ''}${k.revenueChangePct}%), Buchungen ${k.bookingsYtd}, ADR ${eur(k.adr)}`
    ),
    '',
    'Nächste Anreisen:',
    ...model.arrivals.map(
      (a) => `  ${deDate(a.date)} ${a.propertyName} — ${a.guestName} (${a.nights}N/${a.guests}P, ${a.source})${a.isTurnover ? ' [Turnover]' : ''}`
    ),
    '',
    'Forecast (Umsatz, Portfolio):',
    ...model.portfolioForecast.map(
      (m) => m.isOpen
        ? `  ${m.monthLabel}: noch offen (${m.confidence})`
        : `  ${m.monthLabel}: fest ${eur(m.committedRevenue)} → erwartet ${eur(m.expectedRevenue)} (bis ${eur(m.highRevenue)}, ${m.confidence})`
    ),
    '',
    'Forecast pro Property (Σ 6 Mon):',
    ...model.propertyForecasts.map(
      (f) => `  ${f.name}: fest ${eur(f.committedTotal)} → erwartet ${eur(f.expectedTotal)} [${f.methodLabel}, ${f.confidence}]`
    ),
  ];

  return { html, text: textLines.join('\n') };
}
