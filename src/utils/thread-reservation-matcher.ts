/**
 * Match a direct-email message thread to a Guesty reservation (provider=manual).
 *
 * Inputs are deliberately minimal:
 *   - thread.guest_name      — usually "Vorname Nachname" from the From header
 *   - thread.guest_email     — usually "vorname.nachname@company.de"
 *   - reservation.guest_name — Guesty's full name, often "Company GmbH Vorname Nachname"
 *                              (host pre-fills with company)
 *
 * Scoring rules (additive, threshold 2.0 to consider it a match):
 *   +3.0  guest_email-local-part fully contained in reservation guest_name (lowercased)
 *   +2.0  both first AND last name from thread guest_name appear in reservation guest_name
 *   +1.0  email-domain second-level (e.g. 'pexon') appears in reservation guest_name
 *   +1.0  thread guest_name (single token) appears as token in reservation guest_name
 *
 * Returns the best-matching reservation or null. Ties broken by highest score, then
 * by check-in date proximity to thread's last_message_at (closer = better).
 */

export interface ThreadMatcherInput {
  guestName: string | null;
  guestEmail: string | null;
  lastMessageAt: string; // ISO date
}

export interface ReservationMatcherCandidate {
  reservationId: string;
  guestName: string | null;
  checkIn: string;       // ISO date — used as tiebreaker
}

export interface MatchResult {
  reservationId: string;
  score: number;
}

function lc(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().trim();
}

function tokens(s: string | null | undefined): string[] {
  return lc(s)
    .replace(/[,.()]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

// Strip generic legal-form suffixes — "GmbH", "AG", "& Co. KG", etc. — so that
// "Pexon Consulting GmbH" matches against "pexon-consulting.de".
const COMPANY_NOISE = new Set([
  'gmbh', 'ag', 'kg', 'gbr', 'ug', 'mbh', 'co', 'ltd', 'llc',
  'inc', 'gesellschaft', 'partnerschaft', 'verlag', 'verlage', 'verlags',
]);

function meaningfulTokens(s: string | null | undefined): string[] {
  return tokens(s).filter((t) => !COMPANY_NOISE.has(t));
}

function emailLocalPart(email: string | null): string {
  if (!email) return '';
  const at = email.indexOf('@');
  return at > 0 ? lc(email.slice(0, at)) : '';
}

function emailDomainBase(email: string | null): string {
  if (!email) return '';
  const at = email.indexOf('@');
  if (at < 0) return '';
  const domain = email.slice(at + 1).toLowerCase();
  // "pexon-consulting.de" → "pexon-consulting"
  const parts = domain.split('.');
  return parts.length >= 2 ? parts[parts.length - 2] : domain;
}

function scoreMatch(
  thread: ThreadMatcherInput,
  reservation: ReservationMatcherCandidate,
): number {
  const resName = lc(reservation.guestName);
  if (!resName) return 0;

  let score = 0;

  // (1) Email local-part ≥2 tokens all in reservation name
  const localPart = emailLocalPart(thread.guestEmail);
  const localTokens = localPart
    ? localPart.split(/[._-]+/).filter((t) => t.length >= 2)
    : [];
  if (localTokens.length >= 2 && localTokens.every((t) => resName.includes(t))) {
    score += 3.0;
  }

  // (2) Thread first+last name in reservation name
  const threadTokens = meaningfulTokens(thread.guestName);
  if (threadTokens.length >= 2 && threadTokens.every((t) => resName.includes(t))) {
    score += 2.0;
  }

  // (3) Email-domain second-level in reservation name (also space-stripped variant)
  const domainBase = emailDomainBase(thread.guestEmail);
  let domainMatch = false;
  if (domainBase && domainBase.length >= 4) {
    const resNameStripped = resName.replace(/\s+/g, '');
    const domainTokens = domainBase
      .split('-')
      .filter((t) => t.length >= 3 && !COMPANY_NOISE.has(t));
    const needles = domainTokens.length > 0 ? domainTokens : [domainBase];
    for (const tok of needles) {
      if (resName.includes(tok) || resNameStripped.includes(tok)) {
        domainMatch = true;
        break;
      }
    }
    if (domainMatch) score += 1.0;
  }

  // (4) Short reservation name (1-2 meaningful tokens) — match against thread tokens.
  // Handles cases where Guesty reservation has only first name like "Cynthia"
  // and the Gmail thread has the full "Cynthia Mensah-Neglokpe".
  const resTokens = meaningfulTokens(reservation.guestName);
  if (resTokens.length >= 1 && resTokens.length <= 2 && threadTokens.length >= 1) {
    const allResInThread = resTokens.every((rt) =>
      threadTokens.some((tt) => tt === rt || tt.includes(rt) || rt.includes(tt)),
    );
    if (allResInThread) score += 2.0;
  }

  // (5) Domain match + email has firstname.lastname structure → strong signal
  // even when the person name is not in the reservation (reservation = company only).
  // E.g. thomas.griess@digitransform.de vs reservation "digitransform.de Gesellschaft …"
  if (domainMatch && localTokens.length >= 2) {
    score += 2.0;
  }

  // (6) Domain match against a company-named reservation (contains 'GmbH', 'AG', etc.).
  // Strong signal even with initialed email (e.g. lb@orcrist.org ↔ "Orcrist Technologies GmbH …")
  // because companies rarely book multiple times with different employees in our dataset.
  if (domainMatch) {
    const tokensRaw = tokens(reservation.guestName);
    const hasCompanyNoise = tokensRaw.some((t) => COMPANY_NOISE.has(t));
    if (hasCompanyNoise) score += 2.0;
  }

  return score;
}

export function matchThreadToReservation(
  thread: ThreadMatcherInput,
  candidates: ReservationMatcherCandidate[],
  options: { threshold?: number } = {},
): MatchResult | null {
  const threshold = options.threshold ?? 2.0;

  let bestScore = 0;
  let best: ReservationMatcherCandidate | null = null;

  for (const r of candidates) {
    const s = scoreMatch(thread, r);
    if (s > bestScore) {
      bestScore = s;
      best = r;
    } else if (s === bestScore && best && s >= threshold) {
      // Tie-break: closer check-in to thread's last activity wins
      const dCurrent = Math.abs(
        new Date(r.checkIn).getTime() - new Date(thread.lastMessageAt).getTime(),
      );
      const dPrev = Math.abs(
        new Date(best.checkIn).getTime() - new Date(thread.lastMessageAt).getTime(),
      );
      if (dCurrent < dPrev) best = r;
    }
  }

  if (!best || bestScore < threshold) return null;
  return { reservationId: best.reservationId, score: bestScore };
}
