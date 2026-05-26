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

import { callClaudeTool } from './anthropic-client.js';

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

describe('callClaudeTool', () => {
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
    });
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
    expect(callArgs.tool_choice).toEqual({ type: 'tool', name: 'classify_thread' });
    expect(callArgs.tools).toEqual([dummyTool]);
  });

  it('throws a clear error when the response has no tool_use block', async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'I refuse.' }],
    });
    await expect(
      callClaudeTool({ systemPrompt: 's', userMessage: 'm', tool: dummyTool }),
    ).rejects.toThrow(/tool_use/i);
  });

  it('throws ConfigError when ANTHROPIC_API_KEY is missing', async () => {
    vi.resetModules();
    vi.doMock('../config/index.js', () => ({ config: { anthropicApiKey: undefined } }));
    const { callClaudeTool: fresh } = await import('./anthropic-client.js');
    await expect(
      fresh({ systemPrompt: 's', userMessage: 'm', tool: dummyTool }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it('retries on 429 and succeeds on the second attempt', async () => {
    const rateLimit = Object.assign(new Error('rate'), { status: 429 });
    mockCreate
      .mockRejectedValueOnce(rateLimit)
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', name: 'classify_thread', input: { category: 'OTHER', confidence: 0.3 } }],
      });
    const out = await callClaudeTool({ systemPrompt: 's', userMessage: 'm', tool: dummyTool });
    expect(out).toEqual({ category: 'OTHER', confidence: 0.3 });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});
