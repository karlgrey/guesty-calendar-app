/**
 * Language Detection (#695)
 *
 * Deterministische Sprach-Erkennung für Gästenachrichten/Entwürfe (DE/EN/IT/ES/FR), reine
 * Funktion, kein I/O. Bewusst OHNE externe Bibliothek gebaut: eine Test-Stichprobe gegen
 * `franc-min` und `tinyld` (siehe Task-Kommentar #695) zeigte, dass beide auf genau dem
 * Fall scheitern, um den es hier geht — kurze Dank-/Smalltalk-Nachrichten:
 * - franc-min klassifizierte "Danke, alles super!" als Französisch, "Thanks so much, all
 *   good!" als Schwedisch, "Danke!" als Javanisch — auf kurzen Texten praktisch zufällig.
 * - tinyld erkannte "Danke, alles super!"/"Danke!"/"Merci!" gar nicht (leeres Ergebnis),
 *   während es "Thanks!"/"Grazie!"/"Gracias!" traf — asymmetrisches Verhalten, das den
 *   Deutsch-Fallback für französische/deutsche Kurztexte unbemerkt falsch triggern würde.
 * Eine kuratierte Stopwort-Liste pro Sprache ist für genau fünf feste Sprachen und kurze,
 * formelhafte Gäste-Nachrichten robuster und vollständig deterministisch/testbar.
 *
 * Algorithmus: Text in Wort-Tokens zerlegen (nur Unicode-Buchstaben — Zahlen, Satzzeichen
 * UND Emoji fallen dabei automatisch raus, ohne Sonderbehandlung), gegen kuratierte
 * Stopwort-Listen je Sprache zählen, höchster Treffer gewinnt (Prioritätsreihenfolge
 * SUPPORTED_LANGUAGES bei Gleichstand). Eigennamen/Ortsnamen matchen kein Stopwort und
 * kippen die Zählung daher nicht. Kein Treffer (z. B. reiner Name, nur Emoji, leerer Text)
 * → Fallback Deutsch (Spec #695 Punkt 1).
 */

export const SUPPORTED_LANGUAGES = ['de', 'en', 'it', 'es', 'fr'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_LABEL: Record<SupportedLanguage, string> = {
  de: 'Deutsch',
  en: 'Englisch',
  it: 'Italienisch',
  es: 'Spanisch',
  fr: 'Französisch',
};

const FALLBACK: SupportedLanguage = 'de';

// Kuratierte Stopwort-/Funktionswort-Listen, Fokus auf Gäste-Smalltalk (Dank, Bestätigung,
// Begrüßung) plus gängige Funktionswörter. Bewusst kompakt gehalten (Size S) — bei neuen
// Fehlklassifikationen hier ergänzen, keine Bibliothek einwechseln.
const WORDS: Record<SupportedLanguage, Set<string>> = {
  de: new Set([
    'der', 'die', 'das', 'und', 'ist', 'sind', 'nicht', 'ich', 'wir', 'sie', 'mit', 'für',
    'von', 'zu', 'auf', 'ein', 'eine', 'einen', 'einem', 'einer', 'wird', 'hat', 'haben',
    'sehr', 'gut', 'super', 'danke', 'dankeschön', 'vielen', 'herzlichen', 'alles', 'bitte',
    'gerne', 'freuen', 'uns', 'euch', 'klasse', 'toll', 'prima', 'lieben', 'liebe', 'grüße',
    'grüssen', 'viele', 'grüsse', 'tschüss', 'hallo', 'ja', 'nein', 'kein', 'keine', 'wann',
    'wo', 'wie', 'warum', 'können', 'könnte', 'würde', 'möchte', 'brauchen', 'morgen', 'heute',
    'abend', 'passt', 'perfekt', 'nachricht', 'eingerichtet',
  ]),
  en: new Set([
    'the', 'and', 'is', 'are', 'we', 'you', 'thank', 'thanks', 'so', 'much', 'all', 'good',
    'great', 'awesome', 'perfect', 'please', 'welcome', 'hello', 'hi', 'hey', 'yes', 'no',
    'not', 'when', 'where', 'how', 'why', 'can', 'could', 'would', 'like', 'need', 'tomorrow',
    'today', 'tonight', 'looking', 'forward', 'appreciate', 'appreciated', 'really', 'very',
    'best', 'regards', 'cheers', 'see', 'soon', 'lot', 'that', 'was',
  ]),
  it: new Set([
    'il', 'lo', 'la', 'di', 'che', 'grazie', 'mille', 'tutto', 'bene', 'perfetto', 'ciao',
    'buongiorno', 'buonasera', 'molto', 'siamo', 'sono', 'per', 'con', 'una', 'uno', 'gentile',
    'cortesia', 'prego', 'benvenuto', 'domani', 'oggi', 'stasera', 'vorremmo', 'possiamo',
    'quando', 'dove', 'come', 'perché', 'grazie mille',
  ]),
  es: new Set([
    'el', 'la', 'de', 'que', 'gracias', 'todo', 'bien', 'perfecto', 'hola', 'buenos', 'buenas',
    'muy', 'somos', 'estamos', 'para', 'con', 'una', 'uno', 'bienvenido', 'mañana', 'hoy',
    'podemos', 'cuando', 'donde', 'como', 'porque', 'genial', 'muchas',
  ]),
  fr: new Set([
    'le', 'la', 'de', 'que', 'merci', 'tout', 'bien', 'parfait', 'bonjour', 'bonsoir', 'très',
    'nous', 'sommes', 'pour', 'avec', 'une', 'un', 'bienvenue', 'demain', 'aujourdhui', 'ce',
    'soir', 'pouvons', 'quand', 'où', 'comment', 'pourquoi', 'beaucoup', 'est',
  ]),
};

// Sprachtypische Sonderzeichen als schwacher Zusatz-Hinweis (stützt v. a. knappe Texte, in
// denen das Wort selbst nicht in der Liste steht). Bewusst nur eindeutige Zeichen je Sprache.
const CHAR_BONUS: Partial<Record<SupportedLanguage, RegExp>> = {
  de: /[ßüöä]/i,
  es: /[ñ¿¡]/i,
  fr: /[çœ]/i,
};

const WORD_PATTERN = /\p{L}+/gu;

export function detectLanguage(text: string): SupportedLanguage {
  const tokens = (text ?? '').toLowerCase().match(WORD_PATTERN) ?? [];
  const scores: Record<SupportedLanguage, number> = { de: 0, en: 0, it: 0, es: 0, fr: 0 };

  for (const token of tokens) {
    for (const lang of SUPPORTED_LANGUAGES) {
      if (WORDS[lang].has(token)) scores[lang] += 1;
    }
  }
  for (const lang of SUPPORTED_LANGUAGES) {
    const bonusPattern = CHAR_BONUS[lang];
    if (bonusPattern && bonusPattern.test(text)) scores[lang] += 0.5;
  }

  let best: SupportedLanguage = FALLBACK;
  let bestScore = 0;
  for (const lang of SUPPORTED_LANGUAGES) {
    if (scores[lang] > bestScore) {
      best = lang;
      bestScore = scores[lang];
    }
  }
  return bestScore > 0 ? best : FALLBACK;
}
