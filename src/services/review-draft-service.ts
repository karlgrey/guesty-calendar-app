/**
 * Guest-review draft generation (#377).
 *
 * Own prompt block — deliberately NOT sharing draft-service.ts's
 * buildSystemPrompt (design decision, see spec
 * docs/superpowers/specs/2026-08-11-gaeste-bewertungen-design.md
 * "Keine Änderungen am Draft-Prompt der Gästenachrichten"). A guest review is
 * a different genre than a reply: short, public, written ABOUT the guest
 * instead of TO them, and grounded only in the stay + conversation — never a
 * textbank/template.
 */
import { callClaudeTool, type ClaudeToolDefinition } from './anthropic-client.js';

export const REVIEW_MODEL = 'claude-sonnet-5';

export const SUBMIT_REVIEW_TOOL: ClaudeToolDefinition = {
  name: 'submit_review',
  description: 'Gib die fertige öffentliche Gäste-Bewertung zurück (nur den Bewertungstext).',
  input_schema: {
    type: 'object',
    properties: {
      review: { type: 'string', description: 'Die fertige Bewertung des Gastes in Michas Stimme.' },
    },
    required: ['review'],
  },
};

export interface ReviewGenInput {
  guestName: string | null;
  propertyName: string;
  checkInLabel: string; // already formatted for display, e.g. "12.08.2026"
  checkOutLabel: string;
  nights: number | null;
  voice: string;
  // Concatenated chronological "[Gast]/[Host]: text" lines, or '' when the
  // stay had no message thread at all.
  threadHighlights: string;
  /**
   * Set when review-classifier.ts flagged this stay as a problem case
   * (complaint/damage/dispute/escalation) — #377 Nachbesserung, Micha
   * 11.08.2026: we now still draft a review for flagged stays instead of
   * skipping straight to needs_review, but with a hard prompt rule that
   * bans any mention of the problem (see buildSystemPrompt). The
   * classification itself stays visible to Micha via flag_reason on the
   * draft, never in the review text.
   */
  flagged?: boolean;
}

export interface ReviewGenDeps {
  call: typeof callClaudeTool;
}
const defaultDeps: ReviewGenDeps = { call: callClaudeTool };

function buildSystemPrompt(voice: string, flagged: boolean): string {
  return [
    'Du schreibst eine öffentliche Gäste-Bewertung für eine Ferienunterkunft — der Host bewertet den GAST nach dessen Aufenthalt (Airbnb-Feature "Bewertung des Gastes"), NICHT eine Antwort an den Gast.',
    'Halte dich im Ton an die folgende Voice (Stil des Hosts), auch wenn sie primär für Gastnachrichten geschrieben ist — warm, direkt, kompakt, presence-neutral:',
    '--- VOICE ---', voice, '--- ENDE VOICE ---',
    'Regeln für die Bewertung:',
    ...(flagged
      ? [
          '- HARTE REGEL (Problemfall — hat Vorrang vor allen anderen Regeln): Dieser Aufenthalt wurde als Problemfall eingestuft (z. B. Beschwerde, Schaden, Streit, Vorfall, Eskalation). Erwähne oder deute NICHTS davon im Bewertungstext an — kein Wort über Probleme, Konflikte oder Vorfälle, auch nicht indirekt oder verklausuliert. Schreibe ausschließlich neutral-freundlich über die unproblematischen Aspekte des Aufenthalts (z. B. reine Logistik, Pünktlichkeit, Kommunikation). Gibt es davon kaum etwas, bleib kurz und allgemein neutral, statt irgendetwas zu beschönigen oder zu erfinden.',
        ]
      : []),
    '- 2–4 Sätze, konkret statt floskelhaft. Falls der Gast im Verlauf etwas Besonderes gezeigt hat (z. B. sehr kommunikativ, pünktlich, unkompliziert), das aufgreifen — sonst allgemein freundlich bleiben.',
    '- Erfinde NICHTS, das nicht aus dem Aufenthaltskontext oder dem Nachrichtenverlauf hervorgeht — insbesondere keine Beobachtungen über den Zustand der Unterkunft nach der Abreise (dafür gibt es keine Datenquelle).',
    '- Kein Markdown, keine Emojis, keine Anrede/Signatur — reiner Fließtext, wie er direkt auf der Plattform erscheint.',
    '- Sprache: spiegle die Sprache des Gastes aus dem Nachrichtenverlauf (Deutsch oder Englisch). Gab es keinen Verlauf oder ist die Sprache unklar, schreibe auf Deutsch.',
    '- Gib die Bewertung über das Tool submit_review zurück (nur den Bewertungstext).',
  ].join('\n');
}

function buildUserMessage(input: ReviewGenInput): string {
  const lines = [
    `Gast: ${input.guestName ?? 'Name unbekannt'}`,
    `Unterkunft: ${input.propertyName}`,
    `Zeitraum: ${input.checkInLabel}–${input.checkOutLabel}${input.nights != null ? ` (${input.nights} Nächte)` : ''}`,
  ];
  lines.push('');
  lines.push(
    input.threadHighlights.trim()
      ? `Bisheriger Nachrichtenverlauf (chronologisch):\n${input.threadHighlights}`
      : 'Kein Nachrichtenverlauf für diesen Aufenthalt vorhanden.',
  );
  return lines.join('\n');
}

export async function generateReviewForStay(
  input: ReviewGenInput,
  deps: ReviewGenDeps = defaultDeps,
): Promise<string | null> {
  const out = await deps.call({
    systemPrompt: buildSystemPrompt(input.voice, !!input.flagged),
    userMessage: buildUserMessage(input),
    tool: SUBMIT_REVIEW_TOOL,
    model: REVIEW_MODEL,
  });
  const review = (out as { review?: unknown } | null)?.review;
  return typeof review === 'string' && review.trim() ? review.trim() : null;
}
