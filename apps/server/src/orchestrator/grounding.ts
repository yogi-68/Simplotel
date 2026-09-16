import type { Source } from '@hotel/contracts';
import { knowledgeBase, type Fact } from '../domain/knowledge/kb.repository.js';
import type { AssistantOutput } from '../ai/schema.js';

/**
 * Citation validation — the layer that actually prevents unsupported answers.
 *
 * Retrieval narrows what the model can see and the prompt tells it to cite, but
 * neither is a guarantee: a prompt is a request, and a model under pressure will
 * happily produce a fluent sentence with an empty `sourceIds` array. This is the
 * part that makes grounding a postcondition rather than a hope.
 *
 * The rule is asymmetric on purpose. A factual claim about the hotel is only
 * allowed out of the building if it names at least one fact that was genuinely
 * in front of the model this turn. A clarifying question, a greeting, an honest
 * refusal or a narrated availability result have nothing to cite, so they are
 * not held to it — but any ids they *do* carry still have to be real.
 */

export interface GroundingVerdict {
  grounded: boolean;
  sources: Source[];
  /** Ids the model produced that do not exist in this turn's context. */
  unknownIds: string[];
  /** Present when the answer must be discarded. */
  violation?: 'missing_citations' | 'unknown_citations';
}

/** Reply types that make a factual claim and therefore must be supported. */
const REQUIRES_CITATION = new Set<AssistantOutput['type']>(['answer']);

export function validateCitations(output: AssistantOutput, contextFacts: Fact[]): GroundingVerdict {
  const allowed = new Map(contextFacts.map((f) => [f.id, f]));

  const known: Fact[] = [];
  const unknownIds: string[] = [];

  // De-duplicate: models sometimes repeat an id across a list.
  for (const id of new Set(output.sourceIds)) {
    const fact = allowed.get(id);
    if (fact) known.push(fact);
    // An id that exists in the knowledge base but was NOT retrieved this turn is
    // still a violation. It means the model recalled a fact from training rather
    // than reading the context, which is exactly the failure we are guarding
    // against, even when the recalled fact happens to be correct.
    else unknownIds.push(id);
  }

  const sources = known.map((f) => knowledgeBase.toSource(f));

  if (REQUIRES_CITATION.has(output.type)) {
    if (known.length === 0) {
      return {
        grounded: false,
        sources: [],
        unknownIds,
        violation: unknownIds.length > 0 ? 'unknown_citations' : 'missing_citations',
      };
    }
    if (unknownIds.length > 0) {
      // Some citations were real. We keep the answer but drop the invented ids
      // so the guest is never shown a source that does not exist.
      return { grounded: true, sources, unknownIds };
    }
    return { grounded: true, sources, unknownIds: [] };
  }

  return { grounded: true, sources, unknownIds };
}
