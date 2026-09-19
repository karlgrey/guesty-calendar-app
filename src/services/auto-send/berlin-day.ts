/** ISO-Zeitpunkt (UTC) des Kalendertag-Beginns in Europe/Berlin für `now` (Tageslimit, Spec 5.3). */
export function startOfBerlinDayIso(now: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  const wallAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  const offsetMs = Math.round((wallAsUtc - now.getTime()) / 60000) * 60000; // Berlin-Offset (+1h/+2h)
  const dayStartWallAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day);
  return new Date(dayStartWallAsUtc - offsetMs).toISOString();
}
