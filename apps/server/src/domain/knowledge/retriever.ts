import { knowledgeBase, type Fact } from './kb.repository.js';
import { expandQuery, queryTokens, tokenize } from './tokenizer.js';

/**
 * Okapi BM25 over the hotel knowledge base.
 *
 * Why lexical and not embeddings: the corpus is ~47 curated facts. An embedding
 * call per turn would add latency and cost, make every test non-deterministic
 * and break the offline mock provider, in exchange for recall we can buy with a
 * synonym table. The `Retriever` shape below is the seam — swapping in a vector
 * index later means replacing this file and nothing else.
 *
 * Retrieval is layer one of three. It narrows context so the model is less
 * likely to answer a pool question with spa hours. The actual guarantee that we
 * never state an unsupported fact is the citation validator downstream.
 */

const K1 = 1.5;
const B = 0.75;

/** Field boosts, applied by repeating tokens before indexing. */
const TITLE_WEIGHT = 2;
const TAG_WEIGHT = 2;

/**
 * Minimum IDF-weighted query coverage before we consider the knowledge base to
 * actually address the question. Below this the orchestrator tells the model it
 * has NO CONTEXT, whose only legal moves are to refuse or hand off to a human.
 * Tuned against the in-scope / out-of-scope battery in tests/unit/retriever.test.ts.
 */
export const CONTEXT_FLOOR = 0.55;

/**
 * Coverage alone is too strict. In "can I bring my dog?" the verb "bring" is
 * absent from the corpus and, being unseen, carries maximum IDF -- enough to
 * drag coverage below the floor even though the pet policy is a near-perfect
 * match. So we also measure how strongly the single best fact matches, and
 * accept the context if either signal is convincing.
 */
export const STRENGTH_FLOOR = 0.5;

export const DEFAULT_TOP_K = 8;

export interface ScoredFact {
  fact: Fact;
  score: number;
}

export interface RetrievalResult {
  /** Facts chosen for the prompt, best first. */
  facts: Fact[];
  /** Always-present identity facts, appended to `facts` for the prompt. */
  coreFacts: Fact[];
  scored: ScoredFact[];
  /** 0-1 IDF-weighted coverage of the question's distinctive terms. */
  confidence: number;
  /** 0-1 how strongly the single best fact matches, relative to a perfect match. */
  strength: number;
  /** False when the knowledge base does not meaningfully cover the question. */
  hasContext: boolean;
  mode: RetrievalMode;
}

export type RetrievalMode = 'lexical' | 'full';

export interface Retriever {
  search(query: string, opts?: { topK?: number; mode?: RetrievalMode }): RetrievalResult;
  /**
   * Content words in the query that the corpus has never seen, after synonym
   * expansion. A non-empty result means the guest raised a topic this knowledge
   * base has no vocabulary for -- "casino", "helipad" -- which the orchestrator
   * uses to decide that widening the query with conversation history would be
   * manufacturing context rather than resolving a reference.
   */
  unknownTerms(query: string): string[];
}

interface IndexedDoc {
  fact: Fact;
  termFreq: Map<string, number>;
  length: number;
  terms: Set<string>;
}

function buildIndex(facts: Fact[]) {
  const docs: IndexedDoc[] = facts.map((fact) => {
    const tokens = [
      ...repeat(tokenize(fact.title), TITLE_WEIGHT),
      ...tokenize(fact.text),
      ...repeat(tokenize(fact.tags.join(' ')), TAG_WEIGHT),
    ];
    const termFreq = new Map<string, number>();
    for (const token of tokens) termFreq.set(token, (termFreq.get(token) ?? 0) + 1);
    return { fact, termFreq, length: tokens.length, terms: new Set(termFreq.keys()) };
  });

  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc.terms) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  }

  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(docs.length, 1);
  return { docs, docFreq, avgLength, total: docs.length };
}

function repeat(tokens: string[], times: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < times; i += 1) out.push(...tokens);
  return out;
}

export function createRetriever(facts: Fact[] = knowledgeBase.facts()): Retriever {
  const index = buildIndex(facts);

  /**
   * A term the corpus has never seen gets df = 0, which yields the highest
   * possible IDF. That is exactly what we want for coverage scoring: a question
   * about a "casino" is dominated by a term nothing can match, so confidence
   * collapses and the no-context path fires.
   */
  const idf = (term: string): number => {
    const df = index.docFreq.get(term) ?? 0;
    return Math.log(1 + (index.total - df + 0.5) / (df + 0.5));
  };

  const scoreDoc = (doc: IndexedDoc, queryTerms: string[]): number => {
    let score = 0;
    for (const term of queryTerms) {
      const tf = doc.termFreq.get(term);
      if (!tf) continue;
      const norm = tf * (K1 + 1);
      const denom = tf + K1 * (1 - B + (B * doc.length) / index.avgLength);
      score += idf(term) * (norm / denom);
    }
    return score;
  };

  return {
    unknownTerms(query) {
      return [...new Set(tokenize(query))].filter(
        (term) => !expandQuery([term]).some((v) => (index.docFreq.get(v) ?? 0) > 0),
      );
    },

    search(query, opts = {}) {
      const topK = opts.topK ?? DEFAULT_TOP_K;
      const mode = opts.mode ?? 'lexical';

      // Two different token sets, for two different jobs.
      //
      // `searchTerms` is everything worth matching on: content words, synonym
      // expansions, and joined bigrams that recover split compounds like
      // "work out" -> workout. More is better here; a term that matches nothing
      // simply contributes no score.
      //
      // `baseTerms` is only the literal content words of the question, and is
      // what coverage and strength are weighted by. Bigrams must stay out of
      // this set: they are mostly nonsense pairs ("whattime", "timeis") that are
      // absent from the corpus, and since an unseen term carries maximum IDF
      // they would swamp the denominator and make every question look
      // unanswerable.
      const baseTerms = [...new Set(tokenize(query))];
      const searchTerms = expandQuery([...new Set(queryTokens(query))]);

      const scored: ScoredFact[] = index.docs
        .map((doc) => ({ fact: doc.fact, score: scoreDoc(doc, searchTerms), doc }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.fact.id.localeCompare(b.fact.id))
        .map(({ fact, score }) => ({ fact, score }));

      const top = scored.slice(0, topK);

      // `full` mode is the A/B baseline: the whole knowledge base in context.
      // It is still ordered by relevance rather than by file order, so the
      // comparison isolates the one variable that matters -- how much context
      // the model receives -- instead of accidentally measuring whether the
      // consumer happens to read the list top-down.
      const rankedIds = new Set(scored.map((s) => s.fact.id));
      const contextFacts =
        mode === 'full'
          ? [...scored.map((s) => s.fact), ...index.docs.map((d) => d.fact).filter((f) => !rankedIds.has(f.id))]
          : top.map((s) => s.fact);
      const visibleIds = new Set(contextFacts.map((f) => f.id));

      // Coverage asks a corpus-level question -- "does this hotel's knowledge
      // base say anything about these words at all?" -- so it is measured
      // against the whole vocabulary, not the slice we happened to return.
      // Scoring it against the visible slice made the answer depend on topK,
      // which meant widening K could make an out-of-scope question look
      // answerable. That is exactly backwards.
      let totalWeight = 0;
      let matchedWeight = 0;
      for (const term of baseTerms) {
        const weight = idf(term);
        totalWeight += weight;
        // A term counts as covered if it, or any of its synonyms, is indexed.
        const variants = expandQuery([term]);
        if (variants.some((v) => (index.docFreq.get(v) ?? 0) > 0)) matchedWeight += weight;
      }

      const confidence = totalWeight > 0 ? clamp01(matchedWeight / totalWeight) : 0;
      const topScore = top[0]?.score ?? 0;

      // A term's BM25 contribution approaches idf * (K1 + 1) as its frequency
      // grows, so the sum over query terms is a principled upper bound for a
      // "perfect" match. The ratio gives a corpus-independent 0-1 strength.
      const perfectScore = totalWeight * (K1 + 1);
      const strength = perfectScore > 0 ? clamp01(topScore / perfectScore) : 0;

      return {
        facts: contextFacts,
        coreFacts: knowledgeBase.coreFacts().filter((f) => !visibleIds.has(f.id)),
        scored: top,
        confidence,
        strength,
        hasContext: topScore > 0 && (confidence >= CONTEXT_FLOOR || strength >= STRENGTH_FLOOR),
        mode,
      };
    },
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Process-wide singleton: the knowledge base is static, so index once. */
export const retriever = createRetriever();
