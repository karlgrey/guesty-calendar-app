// #1298: Erkennung automatisch versandter Host-Nachrichten (Vorlagen-Texte).
// Solche Nachrichten werden beim Sync als direction 'system' gespeichert, damit sie
// nicht als echte Host-Antwort zählen (needsReply).

/**
 * Bekannte Vorlagen automatischer Host-Nachrichten. Keine /g- oder /y-Flags
 * (sonst lastIndex-Falle bei wiederholtem test()).
 */
export const AUTO_HOST_MESSAGE_PATTERNS: readonly RegExp[] = [
  // Hostex-Vorlage Check-in-Info: geht einen Tag vor Anreise als 'host' raus.
  // Weitere Vorlagen kommen als je ein Listeneintrag mit Test dazu (#1298).
  /dein Aufenthalt findet bald statt\.[\s\S]*einchecken/i,
];

export function isAutomaticHostMessage(
  body: string | null | undefined,
  patterns: readonly RegExp[] = AUTO_HOST_MESSAGE_PATTERNS,
): boolean {
  if (!body) return false;
  return patterns.some((p) => p.test(body));
}
