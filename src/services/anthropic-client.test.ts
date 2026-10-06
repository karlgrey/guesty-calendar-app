import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK before importing the module under test.
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}));

// Mock config to inject the API key.
vi.mock('../config/index.js', () => ({
  config: { anthropicApiKey: 'test-key' },
}));

// Mock logger to avoid pino initialization with undefined log level.
vi.mock('../utils/logger.js', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import logger from '../utils/logger.js';
import { callClaudeTool, toStructuredOutputSchema, usesBetweenTools, SONNET_MODEL } from './anthropic-client.js';

// Legacy-Pfad (#758): Modelle vor Sonnet 5.5 (z. B. Opus-5-Judge) behalten
// thinking: disabled + erzwungenen Tool-Aufruf.
const LEGACY = 'claude-opus-5';

const dummyTool = {
  name: 'classify_thread',
  description: 'Classify a thread.',
  input_schema: {
    type: 'object' as const,
    properties: {
      category: { type: 'string' },
      confidence: { type: 'number' },
    },
    required: ['category', 'confidence'],
  },
};

describe('callClaudeTool (Legacy-Pfad, Modelle vor Sonnet 5.5)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns the parsed tool input on a successful tool_use response', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'tool_use',
          name: 'classify_thread',
          input: { category: 'INFO', confidence: 0.7 },
        },
      ],
    });
    const out = await callClaudeTool({
      systemPrompt: 'You classify things.',
      userMessage: 'thread body',
      tool: dummyTool,
      model: LEGACY,
    });
    expect(out).toEqual({ category: 'INFO', confidence: 0.7 });
  });

  it('sends the system prompt with cache_control: ephemeral', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'tool_use', name: 'classify_thread', input: { category: 'OTHER', confidence: 0.3 } }],
    });
    await callClaudeTool({
      systemPrompt: 'sys',
      userMessage: 'msg',
      tool: dummyTool,
      model: LEGACY,
    });
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
    expect(callArgs.tool_choice).toEqual({ type: 'tool', name: 'classify_thread' });
    expect(callArgs.tools).toEqual([dummyTool]);
    expect(callArgs.thinking).toEqual({ type: 'disabled' });
  });

  it('throws a clear error when the response has no tool_use block', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I refuse.' }],
    });
    await expect(
      callClaudeTool({ systemPrompt: 's', userMessage: 'm', tool: dummyTool, model: LEGACY }),
    ).rejects.toThrow(/tool_use/i);
  });

  it('throws ConfigError when ANTHROPIC_API_KEY is missing', async () => {
    vi.resetModules();
    vi.doMock('@anthropic-ai/sdk', () => ({
      default: vi.fn().mockImplementation(() => ({ messages: { create: vi.fn() } })),
    }));
    vi.doMock('../utils/logger.js', () => ({
      default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    vi.doMock('../config/index.js', () => ({ config: { anthropicApiKey: undefined } }));
    const { callClaudeTool: fresh } = await import('./anthropic-client.js');
    await expect(
      fresh({ systemPrompt: 's', userMessage: 'm', tool: dummyTool }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('retries on 429 and succeeds on the second attempt', async () => {
    vi.useFakeTimers();
    try {
      const rateLimit = Object.assign(new Error('rate'), { status: 429 });
      mockCreate
        .mockRejectedValueOnce(rateLimit)
        .mockResolvedValueOnce({
          content: [{ type: 'tool_use', name: 'classify_thread', input: { category: 'OTHER', confidence: 0.3 } }],
        });
      const pending = callClaudeTool({ systemPrompt: 's', userMessage: 'm', tool: dummyTool, model: LEGACY });
      // Let the first awaited mockCreate reject, then advance past the backoff sleep.
      await vi.runAllTimersAsync();
      const out = await pending;
      expect(out).toEqual({ category: 'OTHER', confidence: 0.3 });
      expect(mockCreate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exhausts MAX_RETRIES and re-throws the last error', async () => {
    vi.useFakeTimers();
    try {
      const serverErr = Object.assign(new Error('server error'), { status: 503 });
      mockCreate.mockRejectedValue(serverErr);
      const pending = callClaudeTool({ systemPrompt: 's', userMessage: 'm', tool: dummyTool });
      // Suppress unhandled-rejection warnings from intermediate retries while timers run.
      pending.catch(() => undefined);
      // Advance through all backoff sleeps; the final attempt re-throws.
      await vi.runAllTimersAsync();
      await expect(pending).rejects.toThrow('server error');
      expect(mockCreate).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// #758: Sonnet 5.5 — thinking between_tools + Structured Outputs
// ---------------------------------------------------------------------------

const strictishTool = {
  name: 'classify_thread',
  description: 'Classify a thread.',
  input_schema: {
    type: 'object' as const,
    properties: {
      category: { type: 'string', enum: ['INFO', 'OTHER'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reasoning: { type: 'string', maxLength: 150 },
      tags: { type: 'array', items: { type: 'object', properties: { t: { type: 'string', minLength: 1 } }, required: ['t'] } },
    },
    required: ['category', 'confidence', 'reasoning'],
  },
};

function soResponse(json: unknown, extra: Record<string, unknown> = {}) {
  return {
    model: 'claude-sonnet-5-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(json) }],
    ...extra,
  };
}

describe('Modell-Weiche (#758)', () => {
  it('Default-Modell ist claude-sonnet-5-5', () => {
    expect(SONNET_MODEL).toBe('claude-sonnet-5-5');
  });

  it('nur Sonnet 5.5 nutzt between_tools', () => {
    expect(usesBetweenTools('claude-sonnet-5-5')).toBe(true);
    expect(usesBetweenTools('claude-sonnet-5')).toBe(false);
    expect(usesBetweenTools('claude-opus-5')).toBe(false);
    expect(usesBetweenTools('claude-sonnet-4-6')).toBe(false);
  });
});

describe('toStructuredOutputSchema (#758)', () => {
  it('setzt additionalProperties:false rekursiv und entfernt nicht unterstützte Constraints', () => {
    const out = toStructuredOutputSchema(strictishTool.input_schema);
    expect(out).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        category: { type: 'string', enum: ['INFO', 'OTHER'] },
        confidence: { type: 'number' },
        reasoning: { type: 'string' },
        tags: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, properties: { t: { type: 'string' } }, required: ['t'] },
        },
      },
      required: ['category', 'confidence', 'reasoning'],
    });
  });

  it('verändert das Eingabe-Schema nicht', () => {
    const before = JSON.stringify(strictishTool.input_schema);
    toStructuredOutputSchema(strictishTool.input_schema);
    expect(JSON.stringify(strictishTool.input_schema)).toBe(before);
  });
});

describe('callClaudeTool (Sonnet 5.5, Structured Outputs)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    vi.mocked(logger.info).mockClear();
  });

  it('nutzt per Default Sonnet 5.5 mit thinking between_tools und output_config.format — ohne tools/tool_choice', async () => {
    mockCreate.mockResolvedValueOnce(soResponse({ category: 'INFO', confidence: 0.7, reasoning: 'r' }));
    const out = await callClaudeTool({ systemPrompt: 'sys', userMessage: 'msg', tool: strictishTool });
    expect(out).toEqual({ category: 'INFO', confidence: 0.7, reasoning: 'r' });
    const args = mockCreate.mock.calls[0][0];
    expect(args.model).toBe('claude-sonnet-5-5');
    expect(args.thinking).toEqual({ type: 'between_tools' });
    expect(args.tools).toBeUndefined();
    expect(args.tool_choice).toBeUndefined();
    expect(args.output_config).toEqual({
      format: { type: 'json_schema', schema: toStructuredOutputSchema(strictishTool.input_schema) },
    });
    // Effort darf bei between_tools nicht über high liegen — wir setzen keins (Default high).
    expect(args.output_config.effort).toBeUndefined();
  });

  it('behält den gecachten Systemprompt unverändert als ersten Block und ergänzt einen JSON-Hinweis dahinter', async () => {
    mockCreate.mockResolvedValueOnce(soResponse({ category: 'INFO', confidence: 0.7, reasoning: 'r' }));
    await callClaudeTool({ systemPrompt: 'sys', userMessage: 'msg', tool: strictishTool });
    const args = mockCreate.mock.calls[0][0];
    expect(args.system[0]).toEqual({ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } });
    expect(args.system).toHaveLength(2);
    expect(args.system[1].text).toContain('classify_thread');
    expect(args.system[1].text).toMatch(/JSON/);
    expect(args.messages).toEqual([{ role: 'user', content: 'msg' }]);
  });

  it('loggt das tatsächlich antwortende Modell (response.model)', async () => {
    mockCreate.mockResolvedValueOnce(soResponse({ category: 'INFO', confidence: 0.7, reasoning: 'r' }));
    await callClaudeTool({ systemPrompt: 's', userMessage: 'm', tool: strictishTool });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-5-5', requestedModel: 'claude-sonnet-5-5', tool: 'classify_thread' }),
      expect.any(String),
    );
  });

  it('ignoriert vorangestellte thinking-Blöcke und liest den Text-Block', async () => {
    mockCreate.mockResolvedValueOnce({
      model: 'claude-sonnet-5-5',
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '', signature: 'x' },
        { type: 'text', text: '{"category":"OTHER","confidence":0.2,"reasoning":"r"}' },
      ],
    });
    const out = await callClaudeTool({ systemPrompt: 's', userMessage: 'm', tool: strictishTool });
    expect(out).toEqual({ category: 'OTHER', confidence: 0.2, reasoning: 'r' });
  });

  it('wiederholt bei Antwort ohne gültiges JSON und liefert den zweiten Versuch', async () => {
    vi.useFakeTimers();
    try {
      mockCreate
        .mockResolvedValueOnce({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Ich rufe jetzt classify_thread auf.' }] })
        .mockResolvedValueOnce(soResponse({ category: 'INFO', confidence: 0.5, reasoning: 'r' }));
      const pending = callClaudeTool({ systemPrompt: 's', userMessage: 'm', tool: strictishTool });
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toEqual({ category: 'INFO', confidence: 0.5, reasoning: 'r' });
      expect(mockCreate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wirft nach erschöpften Versuchen einen klaren Fehler, wenn nie gültiges JSON kommt (kein stiller Leerlauf)', async () => {
    vi.useFakeTimers();
    try {
      mockCreate.mockResolvedValue({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [] });
      const pending = callClaudeTool({ systemPrompt: 's', userMessage: 'm', tool: strictishTool });
      pending.catch(() => undefined);
      await vi.runAllTimersAsync();
      await expect(pending).rejects.toThrow(/JSON/);
      expect(mockCreate).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wirft bei JSON, das kein Objekt ist (z. B. Array), nach den Versuchen', async () => {
    vi.useFakeTimers();
    try {
      mockCreate.mockResolvedValue({ model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '[1,2]' }] });
      const pending = callClaudeTool({ systemPrompt: 's', userMessage: 'm', tool: strictishTool });
      pending.catch(() => undefined);
      await vi.runAllTimersAsync();
      await expect(pending).rejects.toThrow(/JSON/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wirft bei stop_reason refusal sofort (kein Retry) mit Kategorie', async () => {
    mockCreate.mockResolvedValueOnce({
      model: 'claude-sonnet-5-5',
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'general_harms', explanation: 'x' },
      content: [],
    });
    await expect(
      callClaudeTool({ systemPrompt: 's', userMessage: 'm', tool: strictishTool }),
    ).rejects.toThrow(/refusal.*general_harms/i);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('wirft bei stop_reason max_tokens sofort (wie bisher)', async () => {
    mockCreate.mockResolvedValueOnce({ model: 'claude-sonnet-5-5', stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"categ' }] });
    await expect(
      callClaudeTool({ systemPrompt: 's', userMessage: 'm', tool: strictishTool, maxTokens: 64 }),
    ).rejects.toThrow(/max_tokens=64/);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('Legacy-Modell (claude-opus-5) bleibt bei thinking disabled + erzwungenem Tool und loggt ebenfalls response.model', async () => {
    mockCreate.mockResolvedValueOnce({
      model: 'claude-opus-5',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'classify_thread', input: { category: 'INFO', confidence: 1, reasoning: 'r' } }],
    });
    await callClaudeTool({ systemPrompt: 's', userMessage: 'm', tool: strictishTool, model: LEGACY });
    const args = mockCreate.mock.calls[0][0];
    expect(args.thinking).toEqual({ type: 'disabled' });
    expect(args.tool_choice).toEqual({ type: 'tool', name: 'classify_thread' });
    expect(args.output_config).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-5', requestedModel: 'claude-opus-5' }),
      expect.any(String),
    );
  });
});
