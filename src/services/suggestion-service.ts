import { callClaudeTool, type ClaudeToolDefinition } from './anthropic-client.js';

const DRAFT_MODEL = 'claude-sonnet-4-6';

export const PROPOSE_VAULT_EDIT_TOOL: ClaudeToolDefinition = {
  name: 'propose_vault_edit',
  description: 'Schlage eine minimale Ergänzung für die Vault-Datei vor.',
  input_schema: {
    type: 'object',
    properties: {
      target_heading: { type: 'string', description: 'Eine BEREITS in der Datei existierende Überschrift (z. B. „## Anti-Pattern"), unter die der Text kommt.' },
      addition_text: { type: 'string', description: 'Der anzuhängende Text, i. d. R. ein einzelner Markdown-Bullet. Keine Umschreibung der Datei.' },
      rationale: { type: 'string', description: 'Kurze Begründung.' },
    },
    required: ['target_heading', 'addition_text', 'rationale'],
  },
};

export interface SuggestionInput {
  category: 'ton' | 'fakt';
  note: string;
  draftBody: string;
  fileContent: string;
}
export interface SuggestionDeps {
  call: typeof callClaudeTool;
}
const defaultDeps: SuggestionDeps = { call: callClaudeTool };

function buildSystemPrompt(category: 'ton' | 'fakt'): string {
  const kind = category === 'ton' ? 'Ton/Stil (Voice)' : 'Objektfakt';
  return [
    `Du pflegst eine kuratierte Wissensdatei (Kategorie: ${kind}) für Gästekommunikation.`,
    'Formuliere aus dem Feedback eine MINIMALE Ergänzung: einen einzelnen, klaren Markdown-Bullet.',
    'Wähle als target_heading eine Überschrift, die BEREITS in der Datei vorkommt. Erfinde nichts, keine ganze Datei umschreiben.',
    'Antworte über das Tool propose_vault_edit.',
  ].join('\n');
}

function buildUserMessage(input: SuggestionInput): string {
  return [
    `Feedback des Operators: ${input.note}`,
    '',
    'Beanstandeter Entwurf:',
    input.draftBody,
    '',
    'Aktueller Inhalt der Zieldatei:',
    '--- DATEI ---',
    input.fileContent,
    '--- ENDE DATEI ---',
  ].join('\n');
}

export async function generateSuggestion(
  input: SuggestionInput,
  deps: SuggestionDeps = defaultDeps,
): Promise<{ target_heading: string; addition_text: string; rationale: string } | null> {
  const out = (await deps.call({
    systemPrompt: buildSystemPrompt(input.category),
    userMessage: buildUserMessage(input),
    tool: PROPOSE_VAULT_EDIT_TOOL,
    model: DRAFT_MODEL,
  })) as { target_heading?: unknown; addition_text?: unknown; rationale?: unknown } | null;
  const heading = typeof out?.target_heading === 'string' ? out.target_heading.trim() : '';
  const addition = typeof out?.addition_text === 'string' ? out.addition_text.trim() : '';
  const rationale = typeof out?.rationale === 'string' ? out.rationale.trim() : '';
  if (!heading || !addition) return null;
  return { target_heading: heading, addition_text: addition, rationale };
}
