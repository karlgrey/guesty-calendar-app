import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCallClaudeTool = vi.hoisted(() => vi.fn());
vi.mock('../services/anthropic-client.js', () => ({
  callClaudeTool: mockCallClaudeTool,
}));

import { classifyThread } from './message-classifier.js';
import { CLASSIFIER_TOOL, buildClassifierUserMessage } from './classifier-prompt.js';

function msg(direction: 'inbound' | 'outbound' | 'system', body: string) {
  return { direction, body };
}

describe('classifyThread', () => {
  beforeEach(() => {
    mockCallClaudeTool.mockReset();
  });

  it('returns CONFIRMED deterministically and does NOT call the LLM', async () => {
    const out = await classifyThread({
      reservationStatus: 'confirmed',
      channel: 'airbnb',
      messages: [msg('inbound', 'beliebiger Text mit Hochzeit')],
    });
    expect(out.category).toBe('CONFIRMED');
    expect(out.confidence).toBe(1.0);
    expect(out.reasoning).toMatch(/reservation/i);
    expect(mockCallClaudeTool).not.toHaveBeenCalled();
  });

  it('also returns CONFIRMED for reserved and active statuses', async () => {
    for (const status of ['reserved', 'active']) {
      const out = await classifyThread({
        reservationStatus: status,
        channel: 'airbnb',
        messages: [],
      });
      expect(out.category).toBe('CONFIRMED');
    }
    expect(mockCallClaudeTool).not.toHaveBeenCalled();
  });

  it('delegates to the LLM for non-confirmed threads and returns the parsed result', async () => {
    mockCallClaudeTool.mockResolvedValueOnce({
      category: 'SPAM',
      confidence: 0.95,
      reasoning: 'Cold pitch offering host services.',
    });
    const out = await classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [msg('inbound', 'Ich unterstütze Hosts dabei, Auslastung zu steigern.')],
    });
    expect(out).toEqual({
      category: 'SPAM',
      confidence: 0.95,
      reasoning: 'Cold pitch offering host services.',
    });
    expect(mockCallClaudeTool).toHaveBeenCalledTimes(1);
  });

  it('passes the cached system prompt, tool, and formatted user message to the LLM', async () => {
    mockCallClaudeTool.mockResolvedValueOnce({
      category: 'INFO',
      confidence: 0.7,
      reasoning: 'Question about transport.',
    });
    await classifyThread({
      reservationStatus: 'inquiry',
      channel: 'airbnb',
      messages: [msg('inbound', 'Is it possible to arrive by train?')],
    });
    const args = mockCallClaudeTool.mock.calls[0][0];
    expect(args.tool).toBe(CLASSIFIER_TOOL);
    expect(typeof args.systemPrompt).toBe('string');
    expect(args.systemPrompt.length).toBeGreaterThan(500); // big prompt with few-shots
    expect(args.userMessage).toBe(
      buildClassifierUserMessage({
        channel: 'airbnb',
        reservationStatus: 'inquiry',
        messages: [msg('inbound', 'Is it possible to arrive by train?')],
      }),
    );
  });

  it('rejects an LLM response with an invalid category', async () => {
    mockCallClaudeTool.mockResolvedValueOnce({
      category: 'NOT_A_REAL_CATEGORY',
      confidence: 0.5,
      reasoning: 'Hallucinated.',
    });
    await expect(
      classifyThread({
        reservationStatus: 'inquiry',
        channel: 'airbnb',
        messages: [msg('inbound', 'Hello')],
      }),
    ).rejects.toThrow(/category/i);
  });

  it('rejects an LLM response with confidence out of range', async () => {
    mockCallClaudeTool.mockResolvedValueOnce({
      category: 'OTHER',
      confidence: 1.5,
      reasoning: 'Out of range.',
    });
    await expect(
      classifyThread({
        reservationStatus: 'inquiry',
        channel: 'airbnb',
        messages: [msg('inbound', 'Hello')],
      }),
    ).rejects.toThrow(/confidence/i);
  });

  it('propagates API errors from callClaudeTool', async () => {
    mockCallClaudeTool.mockRejectedValueOnce(new Error('rate limited'));
    await expect(
      classifyThread({
        reservationStatus: 'inquiry',
        channel: 'airbnb',
        messages: [msg('inbound', 'Hello')],
      }),
    ).rejects.toThrow(/rate limited/);
  });
});
