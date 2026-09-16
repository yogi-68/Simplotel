import { describe, expect, it } from 'vitest';
import { validateCitations } from '../../src/orchestrator/grounding.js';
import { knowledgeBase, type Fact } from '../../src/domain/knowledge/kb.repository.js';
import type { AssistantOutput } from '../../src/ai/schema.js';

const context: Fact[] = [knowledgeBase.get('F26')!, knowledgeBase.get('F27')!];

const reply = (partial: Partial<AssistantOutput>): AssistantOutput => ({
  answer: 'Check-in starts at 2:00 PM.',
  type: 'answer',
  sourceIds: ['F26'],
  confidence: 0.9,
  needs: [],
  suggestions: [],
  ...partial,
});

describe('citation validation', () => {
  it('accepts a factual answer that cites a fact it was actually shown', () => {
    const verdict = validateCitations(reply({}), context);
    expect(verdict.grounded).toBe(true);
    expect(verdict.violation).toBeUndefined();
    expect(verdict.sources.map((s) => s.id)).toEqual(['F26']);
  });

  it('rejects a factual answer with no citations at all', () => {
    const verdict = validateCitations(reply({ sourceIds: [] }), context);
    expect(verdict.grounded).toBe(false);
    expect(verdict.violation).toBe('missing_citations');
    expect(verdict.sources).toEqual([]);
  });

  it('rejects a factual answer that cites an id which does not exist', () => {
    const verdict = validateCitations(reply({ sourceIds: ['F99'] }), context);
    expect(verdict.grounded).toBe(false);
    expect(verdict.violation).toBe('unknown_citations');
    expect(verdict.unknownIds).toEqual(['F99']);
  });

  it('rejects a real fact that was NOT retrieved this turn', () => {
    // F13 exists in the knowledge base but was never put in front of the model.
    // Citing it means the claim came from training data, not from context --
    // which is the exact failure mode this layer exists to catch, even when the
    // recalled fact happens to be true.
    const verdict = validateCitations(reply({ sourceIds: ['F13'] }), context);
    expect(verdict.grounded).toBe(false);
    expect(verdict.violation).toBe('unknown_citations');
  });

  it('keeps a partly-cited answer but strips the invented ids', () => {
    const verdict = validateCitations(reply({ sourceIds: ['F26', 'F99'] }), context);
    expect(verdict.grounded).toBe(true);
    expect(verdict.sources.map((s) => s.id)).toEqual(['F26']);
    expect(verdict.unknownIds).toEqual(['F99']);
  });

  it('de-duplicates repeated ids', () => {
    const verdict = validateCitations(reply({ sourceIds: ['F26', 'F26'] }), context);
    expect(verdict.sources).toHaveLength(1);
  });

  it('does not demand citations from replies that make no factual claim', () => {
    for (const type of ['clarification', 'fallback', 'handoff', 'smalltalk', 'availability'] as const) {
      const verdict = validateCitations(reply({ type, sourceIds: [] }), context);
      expect(verdict.grounded, type).toBe(true);
      expect(verdict.violation, type).toBeUndefined();
    }
  });

  it('still refuses to show an invented source on a non-factual reply', () => {
    const verdict = validateCitations(reply({ type: 'clarification', sourceIds: ['F99'] }), context);
    expect(verdict.sources).toEqual([]);
    expect(verdict.unknownIds).toEqual(['F99']);
  });

  it('exposes the full fact text so the UI can show the guest the evidence', () => {
    const verdict = validateCitations(reply({}), context);
    expect(verdict.sources[0]?.text).toBe(knowledgeBase.get('F26')?.text);
    expect(verdict.sources[0]?.label).toContain('Check-in');
  });
});
