// src/services/price-topic.ts
// #1243 (Prüfer-Befund 1): Preis-/Rabatt-Thema erkennen, unabhängig von der Wortwahl des Entwurfs.
// Reine Funktionen, kein I/O. Genutzt von:
// - mechanical-checks.ts: Entwurf (price_discount) UND Gastnachrichten seit der letzten Host-Antwort
//   (guest_price_topic) — Preis-/Rabattfrage des Gasts oder Preis/Nachlass im Entwurf → nie auto.
// - draft-service.ts: Schlussregel bei Request-to-Book (keine Bestätigung ankündigen, wenn es um Preis geht).
// Bewusst breit (fail closed): ein Fehltreffer kostet nur einen automatischen Versand, nie eine falsche Antwort.

/** Prozentangabe mit Ziffer oder Zahlwort. */
const PERCENT_WORDS = 'null|eins|ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|fünfzehn|zwanzig|dreißig|vierzig|fünfzig|hundert|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|fifty';
export const PERCENT_RE = new RegExp(String.raw`\d+(?:[.,]\d+)?\s*(?:%|prozent\b|percent\b)|\b(?:${PERCENT_WORDS})\s+(?:prozent|percent)\b`, 'i');

/** Rabatt-/Nachlass-Wörter (in jeder Kategorie ein Preisthema). */
export const DISCOUNT_RE = /\b\w*(?:rabatt|nachlass|ermäßigung|discount)\w*|\bsconto\b/i;

/**
 * Preis- und Verhandlungswörter. Nur im Buchungsanfrage-Kontext ausgewertet (dort ist jede Preis-
 * oder Verhandlungsaussage freigabepflichtig); außerhalb kämen „günstiger Supermarkt“, „Hälfte der
 * Betten“ o. ä. vor. Bewusst KEIN „total“ und KEIN „Kosten“ allein (Gesamtzahl, Nebenkosten).
 */
export const PRICE_TOPIC_RE = new RegExp(
  [
    String.raw`\b\w*preise?n?\b`, String.raw`\bpreislich\w*`, String.raw`\bprices?\b`, String.raw`\bpricing\b`,
    String.raw`\b\w*betrag\w*`, String.raw`\bkostet\b`, String.raw`\bcosts?\b`,
    String.raw`\bgegenangebot\w*`, String.raw`\bcounter-?offer\w*`,
    String.raw`entgegen\s?(?:zu\s?)?komm\w*`, String.raw`\bgünstiger\w*`, String.raw`\bbilliger\w*`, String.raw`\bcheaper\b`,
    String.raw`\bzehntel\b`, String.raw`\bhälfte\b`, String.raw`\breduz\w*`, String.raw`\breduc\w*`, String.raw`\brates?\b`,
    String.raw`\babzieh\w*`, String.raw`\bnachlassen\b`, String.raw`\b(?:weiter|so\s?weit)\s+runter\b`,
    String.raw`\bbudget\w*`, String.raw`\bteuer\w*`, String.raw`\bexpensive\b`, String.raw`\bafford\w*`, String.raw`\bdeal\b`,
  ].join('|'),
  'i',
);

/** Betrag mit Währung (Gastnachricht: „2.600 Euro“, „€300“, „300 EUR“). */
const AMOUNT_WITH_CURRENCY_RE = /\d[\d.,\s]*\s?(?:€|\bEUR\b|\beuros?\b)|(?:€|\bEUR\b)\s?\d/i;

/** Erste Fundstelle eines Preis-/Rabatt-Themas in einem Entwurf (Buchungsanfrage: inkl. Preiswörter). */
export function findDraftPriceTopic(text: string, isBookingRequest: boolean): string | null {
  const m = text.match(PERCENT_RE) ?? text.match(DISCOUNT_RE) ?? (isBookingRequest ? text.match(PRICE_TOPIC_RE) : null);
  return m ? m[0].trim() : null;
}

/** Erste Fundstelle eines Preis-/Rabatt-Themas in Gastnachrichten (Wörter oder Betrag mit Währung). */
export function findGuestPriceTopic(guestMessages: string[]): string | null {
  for (const t of guestMessages) {
    const m = t.match(PERCENT_RE) ?? t.match(DISCOUNT_RE) ?? t.match(PRICE_TOPIC_RE) ?? t.match(AMOUNT_WITH_CURRENCY_RE);
    if (m) return m[0].trim();
  }
  return null;
}
