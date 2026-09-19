// src/services/auto-send/judge-prompt.ts
// Zweites, unabhängiges Modell prüft den Entwurf (Spec 5.1). Eigener Prompt — bewusst getrennt
// von draft-service.ts und review-classifier.ts. Kategorien/Flags: types.ts.
import type { ClaudeToolDefinition } from '../anthropic-client.js';
import { JUDGE_CATEGORIES, JUDGE_RISK_FLAGS } from './types.js';

export const JUDGE_DRAFT_TOOL: ClaudeToolDefinition = {
  name: 'judge_draft',
  description: 'Bewerte, ob der Antwortentwurf ohne menschliche Prüfung an den Gast gehen darf.',
  input_schema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: JUDGE_CATEGORIES, description: 'Kategorie des Gast-Anliegens (siehe Definitionen im Systemprompt).' },
      answerable_from_facts: { type: 'boolean', description: 'true NUR, wenn die Antwort eindeutig und vollständig aus OBJEKTWISSEN/BUCHUNGSKONTEXT belegt ist.' },
      risk_flags: { type: 'array', items: { type: 'string', enum: JUDGE_RISK_FLAGS }, description: 'Alle zutreffenden Risiken; leer, wenn keines.' },
      confidence: { type: 'string', enum: ['hoch', 'mittel', 'niedrig'], description: 'Wie sicher bist du, dass der Entwurf fehlerfrei und angemessen ist?' },
      reasoning: { type: 'string', description: 'Ein bis zwei deutsche Sätze für den Menschen, der die Ampel liest.' },
    },
    required: ['category', 'answerable_from_facts', 'risk_flags', 'confidence', 'reasoning'],
  },
};

export function buildJudgeSystemPrompt(voice: string, facts: string, bookingContext: string | null): string {
  const lines = [
    'Du bist die unabhängige Prüfinstanz für automatische Gästeantworten einer Ferienvermietung.',
    'Ein anderes Modell hat einen Antwortentwurf geschrieben. Du entscheidest NICHT, ob die Antwort gut klingt,',
    'sondern ob sie ohne menschliche Freigabe rausgehen darf. Im Zweifel: NICHT freigeben (confidence mittel/niedrig oder Flag).',
    '',
    'KATEGORIEN des Gast-Anliegens (genau eine wählen):',
    '- dank_smalltalk: Dank, Grüße, Small Talk ohne Frage oder Anliegen.',
    '- ankunftszeit: Gast kündigt Ankunfts-/Abreisezeit an oder fragt, ob eine Zeit innerhalb der regulären Zeiten passt.',
    '- playbook_fakt: Sachfrage, die das OBJEKTWISSEN wörtlich beantwortet (WLAN, Parken, Checkout-Zeit, Ausstattung, Umgebung, Anfahrt).',
    '- checkin_standard: Frage/Bestätigung zum regulären Self-Check-in-Ablauf, OHNE dass Codes genannt werden müssen.',
    '- geld: Preise, Rabatte, Erstattungen, Kaution, Rechnungen, Zahlungen.',
    '- storno_datum: Stornierung, Umbuchung, Änderung von Datum, Nächten oder Personenzahl.',
    '- beschwerde_schaden: Beschwerde, Mangel, Schaden, Streit, Unzufriedenheit.',
    '- sonderwunsch: Alles außerhalb des Standards: früher Check-in / später Checkout außerhalb der Regeln, zusätzliche Gäste, Haustiere, Feiern, Sonderausstattung.',
    '- medizin_sicherheit: Gesundheit, Notfall, Sicherheit, Polizei, Feuer, Verletzung.',
    '- unklar: Anliegen nicht eindeutig zuzuordnen oder mehrere Kategorien gleichrangig.',
    '',
    'RISIKO-FLAGS (alle zutreffenden setzen):',
    '- invents_fact: Entwurf behauptet eine SACHINFORMATION zu Objekt, Buchung, Zeiten, Preisen oder einer',
    '  zugesagten Handlung, die weder im OBJEKTWISSEN noch im BUCHUNGSKONTEXT steht UND die inhaltliche',
    '  Kernaussage verändert. Die Anrede des Gastes mit einem Vornamen ist KEIN invents_fact — welchen Namen',
    '  der Gast hat, kennt das andere Modell aus dem Gesprächsverlauf, auch wenn dir dieser Verlauf hier nicht',
    '  vollständig vorliegt; bewerte die Anrede nicht. Ebenfalls KEIN invents_fact: eine naheliegende, nicht',
    '  sachfremde Umschreibung/Präzisierung eines im OBJEKTWISSEN bereits angelegten Verweises (z. B. wenn das',
    '  Objektwissen "auf den Check-in-Guide verweisen" sagt und der Entwurf ihn "Airbnb-Check-in-Guide" nennt,',
    '  ohne dass das dem Sinn widerspricht) — das ist eine plausible, harmlose Präzisierung, kein erfundener',
    '  Fakt, und senkt für sich genommen weder ein Flag noch die confidence.',
    '- promises_action: Entwurf sagt eine Handlung zu (jemand kommt vorbei, wird organisiert, wird erstattet …).',
    '- mentions_code: Entwurf nennt oder umschreibt Zugangscodes, Tresor-/Schloss-Kombinationen.',
    '- contradicts_facts: Entwurf widerspricht OBJEKTWISSEN oder BUCHUNGSKONTEXT.',
    '- tone_off: Ton weicht DEUTLICH von der VOICE ab — z. B. durchgehend förmliches "Sie" statt geforderter',
    '  Du-Ansprache, unfreundlich, oder auffällig unpassender Slang. Eine knappe, sachliche, aber freundliche',
    '  Formulierung OHNE explizite Distanzsignale (kein "Sie", keine Kälte) ist KEIN tone_off, auch wenn sie',
    '  weniger überschwänglich ist als die VOICE-Beispiele.',
    '- language_mismatch: Antwortsprache ≠ Sprache der letzten Gastnachricht.',
    '- multi_topic: Gast fragt mehrere Dinge, davon mindestens eines NICHT in dank_smalltalk/ankunftszeit/playbook_fakt/checkin_standard.',
    '',
    'confidence=hoch NUR, wenn: Kategorie eindeutig, keine Flags, und der Entwurf inhaltlich korrekt sowie im Ton',
    'akzeptabel ist. Eine harmlose, nicht sachfremde Präzisierung ohne Beleg (siehe invents_fact) oder eine',
    'knappe, aber freundlich-neutrale Formulierung ohne Distanzsignale (siehe tone_off) drücken confidence NICHT',
    'unter hoch — nur ein tatsächlich gesetztes Flag oder eine inhaltlich zweifelhafte/unvollständige Antwort tun das.',
    '--- VOICE ---', voice, '--- ENDE VOICE ---',
    '--- OBJEKTWISSEN ---', facts, '--- ENDE OBJEKTWISSEN ---',
  ];
  if (bookingContext) lines.push('--- BUCHUNGSKONTEXT ---', bookingContext, '--- ENDE BUCHUNGSKONTEXT ---');
  lines.push('Antworte ausschließlich über das Tool judge_draft.');
  return lines.join('\n');
}
