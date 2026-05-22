/**
 * Conversation thread classifier.
 *
 * Inputs: thread + array of message bodies (with direction).
 * Output: { category, confidence, matchedKeywords }.
 *
 * Categories (priority order — first match wins):
 *   CONFIRMED      — reservation_status indicates a booking happened
 *   REPEAT         — returning guest (manually set, no auto-rule yet)
 *   SPAM           — host-directed cold pitch (property management, listing
 *                    services, review boosting). Not a real guest inquiry.
 *   COMMERCIAL     — guest wants to use the property commercially (photo/video
 *                    shoot, brand/influencer collaboration)
 *   PARTY          — guest asks for wedding/event/day-use venue (host typically declines)
 *   DIRECT_DRIFT   — explicit attempt to take the conversation off-platform
 *                    (guest hands out email/phone/website OR host pulls the guest back to Airbnb)
 *   PRICE          — explicit price negotiation (budget < listing price, "günstiger", "discount")
 *   PLAN_CHANGE    — guest's plans change (date conflict, travel cancelled). Manually set.
 *   OTHER          — none of the above
 *
 * The thresholds are conservative: when in doubt, return OTHER with low confidence
 * rather than mis-categorizing. The dashboard surfaces low-confidence picks for review.
 */

import type { ConversionCategory } from '../types/messages.js';
export type { ConversionCategory };

export interface ClassifierInput {
  reservationStatus?: string | null;
  channel: string;
  messages: Array<{ direction: 'inbound' | 'outbound' | 'system'; body: string }>;
}

export interface ClassifierResult {
  category: ConversionCategory;
  confidence: number;
  matchedKeywords: string[];
}

// ── Patterns ────────────────────────────────────────────────────────────────

const PARTY_RE =
  /\b(hochzeit|wedding|heirat|trauung|junggesellinnen|jga|polter|hochzeitsfeier|wedding-?party|bachelor[a-z]*party|geburtstagsparty|taufe|baptism|jubil[äa]um)\b/i;

const EVENT_DAY_USE_RE =
  /\b(tages?vermietung|day-?use|day rate|tagesnutzung|feier|veranstaltung|event location|location for our event|reception|ceremony|catering)\b/i;

// ── COMMERCIAL: guest wants to USE the property commercially — photo/video
// shoot, brand/influencer collaboration. Checked after SPAM (host-directed
// pitches are already out) and before PARTY.
const COMMERCIAL_RE =
  /\b(foto-?shooting|foto-?shoot|photo\s?shoot|shootings?|fotograf(in)?|videograf(in)?|foto-?dreh|videodreh|filmdreh|dreharbeiten|drehort|drehgenehmigung|musikvideo|video\s?shoot|content\s?creator|content\s?creation|influencer|marken[-\s]?kooperation)\b/i;
const COMMERCIAL_LOCATION_RE =
  /\b(als location f[üu]r|location f[üu]r (ein|eine|einen|unser|unsere|mein|meine)\s+\w*\s*(shoot|shooting|dreh|video|projekt|kampagne))/i;

const PRICE_RE =
  /\b(budget|preisanfrage|preisnachlass|verhandeln|negoti[a-z]+|cheaper|g[üu]nstig(er)?|reduzieren|reduce|discount|rabatt|deal|niedriger|too expensive|zu teuer|teuer|expensive|afford|leisten|sonderpreis|cost|kosten|under (the )?budget|over (the )?budget)\b/i;

const PRICE_NUMBER_RE = /(€\s*\d{2,5}|\d{2,5}\s*€)/;

// Guest-side drift signals: explicit hand-out of off-platform contact details.
// Airbnb's content filter strips most of these, but residuals slip through.
// Carefully avoid generic @domain matches (host signatures contain them).
const GUEST_DRIFT_RE =
  /\b(my (e-?)?mail (is|address)|meine (e-?)?mail (ist|lautet)|telefon(nummer)? (ist|lautet)|phone (number|is)|handynummer|whatsapp|signal\s+me|telegram|skype|instagram dm|kontakt(iere)?\s+mich\s+(per|au[ßs]erhalb|direkt|über)|au[ßs]erhalb der plattform|off-?platform|outside (of )?airbnb|out of airbnb|outside this platform|direkt(buchung| buchen|\s+über\s+(dich|euch|sie))|booking direct|direct booking|direkt über dich|über\s+eure\s+webseite|farmhouse-?prasser\.de(?!.*signature))\b/i;

// Host-side pull-back signals: host explicitly tells guest to use the platform.
// Allow up to ~25 chars between trigger and "airbnb" to catch "bucht regulär hier über Airbnb",
// "regulär hier auf der Plattform buchen", etc.
const HOST_PULLBACK_RE =
  /(über\s+airbnb\s+(buchen|laufen|abwickeln|mieten)|bitte\s+(bucht\s+)?(regul[äa]r|einfach)\s+[^.\n]{0,30}airbnb|regul[äa]r\s+[^.\n]{0,30}airbnb\s+(buchen|mieten)|please\s+book\s+(via|through)\s+airbnb|use\s+the\s+airbnb\s+platform|kann\s+nur\s+über\s+airbnb|nur\s+über\s+(die\s+)?plattform|einfach\s+(hier\s+)?(regul[äa]r\s+)?über\s+airbnb|über\s+(diese|die)\s+plattform\s+(nicht|laufen|abwickeln))/i;

// ── SPAM: host-directed cold pitch — someone selling the HOST a service
// (property management, listing photography, review boosting). Not a guest.
const SPAM_STRONG_RE =
  /(ich unterst[üu]tze\s+(hosts?|gastgeber|vermieter)|auslastung[^.\n]{0,40}steiger|umsatz[^.\n]{0,40}steiger|bewertungs(score|management)|feedback-?l[öo]sung|360[^a-z0-9]{0,4}rundgang|mehr buchungen[^.\n]{0,40}(generier|erziel|bekomm))/i;

// host-directed possessive ...
const SPAM_TARGET_RE =
  /\b(dein|deine|deiner|ihr|ihre|ihrer|eure?|euer)\s+(inserat|unterkunft|ferienwohnung|fewo|objekt|vermietung|listing|immobilie)/i;
// ... combined with a service/offer verb
const SPAM_OFFER_RE =
  /(biete|anbieten|unterst[üu]tz|optimier|steiger|verwalt|pr[äa]sentier|vorstellen|helfe\s+(dir|ihnen|euch)|dienstleistung)/i;

// ── Keyword extraction (for transparency in dashboard) ──────────────────────

const KEYWORD_INDEX: Array<{ name: string; re: RegExp }> = [
  // party
  { name: 'hochzeit', re: /\bhochzeit/i },
  { name: 'wedding', re: /\bwedding/i },
  { name: 'tagesvermietung', re: /\btagesvermietung/i },
  { name: 'feier', re: /\bfeier\w*/i },
  { name: 'taufe', re: /\b(taufe|baptism)\b/i },
  { name: 'event', re: /\bevent\b/i },
  // drift
  { name: 'whatsapp', re: /\bwhatsapp\b/i },
  { name: 'phone-number-shared', re: /\b(telefon|phone)\s*(nummer|number|ist|is)/i },
  { name: 'email-shared', re: /\b(my (e-?)?mail|meine (e-?)?mail)\b/i },
  { name: 'off-platform', re: /\b(au[ßs]erhalb|off-?platform|outside\s+airbnb)\b/i },
  { name: 'direct-booking', re: /\b(direkt(buchung| buchen)|direct booking|book direct)\b/i },
  { name: 'website-shared', re: /\b(meine\s+website|farmhouse-?prasser\.de|webseite)\b/i },
  { name: 'host-pullback-airbnb', re: /\büber\s+airbnb\b/i },
  // spam
  { name: 'host-pitch', re: /\bich unterst[üu]tze\s+(hosts?|gastgeber|vermieter)\b/i },
  { name: 'auslastung-steigern', re: /auslastung[^.\n]{0,40}steiger/i },
  { name: 'bewertungsscore', re: /bewertungs(score|management)/i },
  // commercial
  { name: 'fotoshoot', re: /\b(fotoshoot|photo-?shoot|drehort)\b/i },
  { name: 'fotograf', re: /\bfotograf(in)?\b/i },
  { name: 'dreh', re: /\b(dreh(ort|arbeiten|genehmigung)?|videodreh|filmdreh)\b/i },
  { name: 'content-creator', re: /\b(content\s?creator|influencer)\b/i },
  // price
  { name: 'budget', re: /\bbudget\b/i },
  { name: 'preis', re: /\b(preis|preisanfrage|preisnachlass)\b/i },
  { name: 'rabatt', re: /\b(rabatt|discount)\b/i },
  { name: 'zu-teuer', re: /\b(too expensive|zu teuer)\b/i },
  { name: 'günstiger', re: /\bg[üu]nstig(er)?\b/i },
  { name: 'verhandeln', re: /\b(verhandeln|negoti)/i },
  { name: 'price-number', re: /(€\s*\d{2,5}|\d{2,5}\s*€)/ },
];

function extractKeywords(text: string): string[] {
  return KEYWORD_INDEX.filter((kw) => kw.re.test(text)).map((kw) => kw.name);
}

// ── Main classifier ────────────────────────────────────────────────────────

function joinByDirection(
  messages: ClassifierInput['messages'],
  direction: 'inbound' | 'outbound',
): string {
  return messages
    .filter((m) => m.direction === direction)
    .map((m) => m.body || '')
    .join('\n');
}

export function classifyThread(input: ClassifierInput): ClassifierResult {
  const { reservationStatus, messages, channel } = input;

  // CONFIRMED — booking actually happened. Highest priority, no further matching.
  if (
    reservationStatus === 'confirmed' ||
    reservationStatus === 'reserved' ||
    reservationStatus === 'active'
  ) {
    return { category: 'CONFIRMED', confidence: 1.0, matchedKeywords: [] };
  }

  const guestText = joinByDirection(messages, 'inbound');
  const hostText = joinByDirection(messages, 'outbound');
  const all = `${guestText}\n${hostText}`;

  // SPAM — host-directed cold pitch. Checked early so a pitch mentioning
  //   "Budget"/"Event" can't be mis-tagged as PRICE/PARTY.
  const spamStrong = SPAM_STRONG_RE.test(guestText);
  const spamCombo = SPAM_TARGET_RE.test(guestText) && SPAM_OFFER_RE.test(guestText);
  if (spamStrong || spamCombo) {
    return {
      category: 'SPAM',
      confidence: spamCombo ? 0.8 : 0.85,
      matchedKeywords: extractKeywords(all),
    };
  }

  // COMMERCIAL — commercial use of the property (shoots, collaborations).
  if (COMMERCIAL_RE.test(guestText) || COMMERCIAL_LOCATION_RE.test(guestText)) {
    return {
      category: 'COMMERCIAL',
      confidence: 0.8,
      matchedKeywords: extractKeywords(all),
    };
  }

  // PARTY / DAY-USE — strongly correlated with declined-by-host.
  const partyHit = PARTY_RE.test(all) || EVENT_DAY_USE_RE.test(all);
  if (partyHit) {
    return {
      category: 'PARTY',
      confidence: 0.85,
      matchedKeywords: extractKeywords(all),
    };
  }

  // DIRECT_DRIFT — only meaningful for Airbnb conversations.
  //    Direct-email threads are already off-platform by definition; drift detection
  //    on the thread-level can't tell you whether it ORIGINATED on Airbnb. Cross-
  //    referencing Airbnb threads with direct-email threads of the same guest is
  //    the proper drift signal (handled at dashboard level via internal_guest_id).
  if (channel !== 'direct_email') {
    const guestDrift = GUEST_DRIFT_RE.test(guestText);
    const hostPullback = HOST_PULLBACK_RE.test(hostText);
    if (guestDrift || hostPullback) {
      let confidence = 0.6;
      if (guestDrift && hostPullback) confidence = 0.95;
      else if (hostPullback) confidence = 0.9;
      else if (guestDrift) confidence = 0.65;
      return {
        category: 'DIRECT_DRIFT',
        confidence,
        matchedKeywords: extractKeywords(all),
      };
    }
  }

  // PRICE — explicit price negotiation.
  if (PRICE_RE.test(all) && PRICE_NUMBER_RE.test(all)) {
    return {
      category: 'PRICE',
      confidence: 0.8,
      matchedKeywords: extractKeywords(all),
    };
  }
  if (PRICE_RE.test(all)) {
    return {
      category: 'PRICE',
      confidence: 0.6,
      matchedKeywords: extractKeywords(all),
    };
  }

  // Fall-through
  return { category: 'OTHER', confidence: 0.3, matchedKeywords: [] };
}
