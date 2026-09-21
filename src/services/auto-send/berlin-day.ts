const berlinDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

/** Berlin-Offset (in ms, inkl. Vorzeichen Ost von UTC) am Zeitpunkt `at` — +1h/+2h je nach DST. */
function berlinOffsetMs(at: Date): number {
  const p = Object.fromEntries(berlinDateFmt.formatToParts(at).map((x) => [x.type, x.value]));
  const wallAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((wallAsUtc - at.getTime()) / 60000) * 60000;
}

/** ISO-Zeitpunkt (UTC) des Kalendertag-Beginns in Europe/Berlin für `now` (Tageslimit, Spec 5.3). */
export function startOfBerlinDayIso(now: Date = new Date()): string {
  const p = Object.fromEntries(berlinDateFmt.formatToParts(now).map((x) => [x.type, x.value]));
  const dayStartWallAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day);
  // Mitternacht gilt am Umstellungstag noch mit dem alten Offset — deshalb den Offset
  // am Mitternachts-Kandidaten neu bestimmen statt an `now`.
  const candidate = dayStartWallAsUtc - berlinOffsetMs(now);
  return new Date(dayStartWallAsUtc - berlinOffsetMs(new Date(candidate))).toISOString();
}

/**
 * Nächster Werktag (Mo–Fr) nach dem Berliner Kalendertag von `now`, als "YYYY-MM-DD"
 * (Format des SmartTasks-`dueDate`-Felds) — für die Zusagen-Task-Anlage (#696, Regel
 * Micha: Fälligkeiten nie auf Samstag/Sonntag). Zählt IMMER ab morgen (ein Task, der
 * gerade eben angelegt wurde, ist frühestens am nächsten Tag fällig), überspringt dann
 * Wochenend-Tage. Rechnet rein auf Kalendertagen (UTC-Datumsarithmetik auf dem in Berlin
 * abgelesenen Datum) — Uhrzeit/DST spielen für ein reines Datum keine Rolle.
 */
export function nextBerlinBusinessDay(now: Date = new Date()): string {
  const p = Object.fromEntries(berlinDateFmt.formatToParts(now).map((x) => [x.type, x.value]));
  let d = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
  do {
    d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

const WEEKDAY_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

/**
 * "Mo 22:35" — Berliner Wochentag + Uhrzeit eines ISO-Zeitpunkts, für Reason-Text/Task-
 * Beschreibung der Airbnb-24h-Frist einer Buchungsanfrage (#697). Wochentag wird aus dem in
 * Berlin abgelesenen Kalendertag bestimmt (Y/M/D als UTC-Datum interpretiert — Wochentag hängt
 * nur vom Kalendertag ab, nicht von der Uhrzeit/DST).
 */
export function formatBerlinDeadline(iso: string): string {
  const at = new Date(iso);
  const p = Object.fromEntries(berlinDateFmt.formatToParts(at).map((x) => [x.type, x.value]));
  const weekday = WEEKDAY_DE[new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay()];
  return `${weekday} ${p.hour}:${p.minute}`;
}

/**
 * "YYYY-MM-DD" Kalendertag in Europe/Berlin eines ISO-Zeitpunkts (SmartTasks-`dueDate`-Format) —
 * für die Buchungsanfrage-Frist (#697). Bewusst OHNE Werktags-Verschiebung
 * (anders als nextBerlinBusinessDay): die Airbnb-24h-Frist gilt real auch am Wochenende — eine
 * bewusste Ausnahme von der sonstigen Werktags-Due-Date-Regel (im Task-Text kenntlich zu machen).
 */
export function berlinCalendarDay(iso: string): string {
  const at = new Date(iso);
  const p = Object.fromEntries(berlinDateFmt.formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
