/**
 * Conversation thread classifier.
 *
 * Inputs: thread + array of message bodies (with direction).
 * Output: { category, confidence, matchedKeywords }.
 *
 * Categories (priority order — first match wins):
 *   CONFIRMED      — reservation_status indicates a booking happened
 *   WEDDING        — guest asks for wedding/event/day-use venue (host typically declines)
 *   DIRECT_DRIFT   — explicit attempt to take the conversation off-platform
 *                    (guest hands out email/phone/website OR host pulls the guest back to Airbnb)
 *   GROUP_EVENT    — corporate offsite / team event keywords (often book, but kept separate)
 *   PRICE          — explicit price negotiation (budget < listing price, "günstiger", "discount")
 *   OTHER          — none of the above
 *
 * The thresholds are conservative: when in doubt, return OTHER with low confidence
 * rather than mis-categorizing. The dashboard surfaces low-confidence picks for review.
 */

export type ConversionCategory =
  | 'CONFIRMED'
  | 'PRICE'
  | 'WEDDING'
  | 'DIRECT_DRIFT'
  | 'GROUP_EVENT'
  | 'OTHER';

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

const WEDDING_RE =
  /\b(hochzeit|wedding|heirat|trauung|junggesellinnen|jga|polter|hochzeitsfeier|wedding-?party|bachelor[a-z]*party|geburtstagsparty|taufe|baptism|jubil[äa]um)\b/i;

const EVENT_DAY_USE_RE =
  /\b(tages?vermietung|day-?use|day rate|tagesnutzung|feier|veranstaltung|event location|location for our event|drehort|fotoshoot|photo[-\s]?shoot|musikvideo|video shoot|reception|ceremony|catering)\b/i;

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

const GROUP_EVENT_RE =
  /\b(offsite|off-?site|teamevent|company\s+retreat|company\s+offsite|corporate\s+retreat|workshop|workation|kick-?off|seminar|tagung|incentive|firmenfeier|gesch[äa]fts(reise|treffen)|workshop|business\s+trip|company\s+trip|team\s+retreat|firm[ae]nausflug)\b/i;

// ── Keyword extraction (for transparency in dashboard) ──────────────────────

const KEYWORD_INDEX: Array<{ name: string; re: RegExp }> = [
  // wedding
  { name: 'hochzeit', re: /\bhochzeit/i },
  { name: 'wedding', re: /\bwedding/i },
  { name: 'tagesvermietung', re: /\btagesvermietung/i },
  { name: 'feier', re: /\bfeier\w*/i },
  { name: 'taufe', re: /\b(taufe|baptism)\b/i },
  { name: 'event', re: /\bevent\b/i },
  { name: 'fotoshoot', re: /\b(fotoshoot|photo-?shoot|drehort)\b/i },
  // drift
  { name: 'whatsapp', re: /\bwhatsapp\b/i },
  { name: 'phone-number-shared', re: /\b(telefon|phone)\s*(nummer|number|ist|is)/i },
  { name: 'email-shared', re: /\b(my (e-?)?mail|meine (e-?)?mail)\b/i },
  { name: 'off-platform', re: /\b(au[ßs]erhalb|off-?platform|outside\s+airbnb)\b/i },
  { name: 'direct-booking', re: /\b(direkt(buchung| buchen)|direct booking|book direct)\b/i },
  { name: 'website-shared', re: /\b(meine\s+website|farmhouse-?prasser\.de|webseite)\b/i },
  { name: 'host-pullback-airbnb', re: /\büber\s+airbnb\b/i },
  // price
  { name: 'budget', re: /\bbudget\b/i },
  { name: 'preis', re: /\b(preis|preisanfrage|preisnachlass)\b/i },
  { name: 'rabatt', re: /\b(rabatt|discount)\b/i },
  { name: 'zu-teuer', re: /\b(too expensive|zu teuer)\b/i },
  { name: 'günstiger', re: /\bg[üu]nstig(er)?\b/i },
  { name: 'verhandeln', re: /\b(verhandeln|negoti)/i },
  { name: 'price-number', re: /(€\s*\d{2,5}|\d{2,5}\s*€)/ },
  // group
  { name: 'offsite', re: /\b(offsite|off-?site)\b/i },
  { name: 'team-event', re: /\b(teamevent|company\s+(retreat|offsite|trip))\b/i },
  { name: 'workshop', re: /\bworkshop\b/i },
  { name: 'workation', re: /\bworkation\b/i },
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

  // 1) CONFIRMED — booking actually happened. Highest priority, no further matching.
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

  // 2) WEDDING / DAY-USE — strongly correlated with declined-by-host.
  const weddingHit = WEDDING_RE.test(all) || EVENT_DAY_USE_RE.test(all);
  if (weddingHit) {
    return {
      category: 'WEDDING',
      confidence: 0.85,
      matchedKeywords: extractKeywords(all),
    };
  }

  // 3) DIRECT_DRIFT — only meaningful for Airbnb conversations.
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

  // 4) GROUP_EVENT — corporate / team / workation. Often books but flagged separately.
  if (GROUP_EVENT_RE.test(all)) {
    return {
      category: 'GROUP_EVENT',
      confidence: 0.7,
      matchedKeywords: extractKeywords(all),
    };
  }

  // 5) PRICE — explicit price negotiation.
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

  // 6) Fall-through
  return { category: 'OTHER', confidence: 0.3, matchedKeywords: [] };
}
