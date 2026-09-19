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
