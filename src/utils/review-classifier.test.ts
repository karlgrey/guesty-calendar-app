import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCallClaudeTool = vi.hoisted(() => vi.fn());
vi.mock('../services/anthropic-client.js', () => ({
  callClaudeTool: mockCallClaudeTool,
}));

import { classifyStayForReview } from './review-classifier.js';
import { REVIEW_CLASSIFIER_TOOL, buildReviewClassifierUserMessage } from './review-classifier-prompt.js';

function msg(direction: 'inbound' | 'outbound' | 'system', body: string) {
  return { direction, body };
}

describe('classifyStayForReview', () => {
  beforeEach(() => {
    mockCallClaudeTool.mockReset();
  });

  it('delegates to the LLM and returns the parsed classification', async () => {
    mockCallClaudeTool.mockResolvedValueOnce({ classification: 'ok', reasoning: 'Nothing stood out.' });
    const out = await classifyStayForReview({ messages: [msg('inbound', 'Danke für den tollen Aufenthalt!')] });
    expect(out).toEqual({ classification: 'ok', reasoning: 'Nothing stood out.' });
    expect(mockCallClaudeTool).toHaveBeenCalledTimes(1);
  });

  it('passes the tool and formatted user message to the LLM', async () => {
    mockCallClaudeTool.mockResolvedValueOnce({ classification: 'flagged', reasoning: 'Complaint about heating.' });
    const input = { messages: [msg('inbound', 'Die Heizung ging nicht.')] };
    await classifyStayForReview(input);
    const args = mockCallClaudeTool.mock.calls[0][0];
    expect(args.tool).toBe(REVIEW_CLASSIFIER_TOOL);
    expect(typeof args.systemPrompt).toBe('string');
    expect(args.systemPrompt.length).toBeGreaterThan(300);
    expect(args.userMessage).toBe(buildReviewClassifierUserMessage(input));
  });

  it('rejects an LLM response with an invalid classification', async () => {
    mockCallClaudeTool.mockResolvedValueOnce({ classification: 'maybe', reasoning: 'Hallucinated.' });
    await expect(classifyStayForReview({ messages: [] })).rejects.toThrow(/classification/i);
  });

  it('rejects an LLM response with missing reasoning', async () => {
    mockCallClaudeTool.mockResolvedValueOnce({ classification: 'ok', reasoning: '' });
    await expect(classifyStayForReview({ messages: [] })).rejects.toThrow(/reasoning/i);
  });

  it('propagates API errors from callClaudeTool', async () => {
    mockCallClaudeTool.mockRejectedValueOnce(new Error('rate limited'));
    await expect(classifyStayForReview({ messages: [] })).rejects.toThrow(/rate limited/);
  });
});
