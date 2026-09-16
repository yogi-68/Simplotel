import { describe, expect, it } from 'vitest';
import { CONTEXT_FLOOR, createRetriever, retriever } from '../../src/domain/knowledge/retriever.js';
import { expandQuery, queryTokens, tokenize } from '../../src/domain/knowledge/tokenizer.js';
import type { Fact } from '../../src/domain/knowledge/kb.repository.js';

const topId = (query: string) => retriever.search(query).scored[0]?.fact.id;

describe('tokenizer', () => {
  it('drops stopwords and keeps meaning', () => {
    expect(tokenize('What time is the check-in?')).toContain('checkin');
    expect(tokenize('What time is the check-in?')).not.toContain('is');
  });

  it('indexes hyphenated words under both spellings', () => {
    const tokens = tokenize('check-in');
    expect(tokens).toContain('checkin');
    expect(tokens).toContain('check');
  });

  it('normalises number words so "three guests" matches "3 adults"', () => {
    expect(tokenize('three guests')).toContain('3');
    expect(tokenize('a couple')).toContain('2');
  });

  it('singularises conservatively and never mangles short words or double-s', () => {
    expect(tokenize('rooms')).toContain('room');
    expect(tokenize('facilities')).toContain('facility');
    expect(tokenize('gas')).toContain('gas');
  });

  it('expands a query term to its concept cluster but leaves documents alone', () => {
    expect(expandQuery(['swimming'])).toContain('pool');
    expect(expandQuery(['kid'])).toContain('child');
  });

  it('rejoins compounds guests split in two, even across a stopword', () => {
    expect(queryTokens('is there somewhere to work out')).toContain('workout');
    expect(queryTokens('when do I check out')).toContain('checkout');
    expect(queryTokens('is there wi fi')).toContain('wifi');
  });

  it('keeps polysemous words out of concept clusters', () => {
    // Grouping "close" with "nearby" made "what time does the spa close"
    // retrieve the list of nearby attractions.
    expect(expandQuery(['close'])).toEqual(['close']);
  });
});

describe('retrieval quality', () => {
  it('finds the right fact for each of the questions in the brief', () => {
    expect(topId('What time is check-in?')).toBe('F26');
    expect(topId('Does the hotel have a swimming pool?')).toBe('F13');
    expect(topId('Which room is suitable for three guests?')).toBe('F08');
    expect(topId('Is breakfast included?')).toBe('F22');
    expect(topId('What is the cancellation policy?')).toBe('F29');
  });

  it('bridges vocabulary gaps through synonyms', () => {
    // None of these words appear verbatim in the matching fact.
    expect(topId('can I go for a swim')).toBe('F13');
    expect(topId('where do I leave the car')).toBe('F19');
    expect(topId('is there somewhere to work out')).toBe('F15');
  });

  it('ranks by relevance, best fact first', () => {
    const result = retriever.search('what time does the spa close');
    expect(result.scored[0]?.fact.id).toBe('F16');
    const scores = result.scored.map((s) => s.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('respects the requested result size', () => {
    expect(retriever.search('room', { topK: 3 }).scored.length).toBeLessThanOrEqual(3);
  });
});

describe('the no-context gate', () => {
  // The battery the two thresholds were tuned against. Adding a phrasing here
  // that fails is the signal to revisit the synonym table or the floors --
  // these are the numbers behind the claim in EVALUATION.md, not a guess.
  const IN_SCOPE = [
    'What time is check-in?',
    'Does the hotel have a swimming pool?',
    'Which room is suitable for three guests?',
    'Is breakfast included?',
    'What is the cancellation policy?',
    'Can I bring my dog?',
    'Do you have parking for my car?',
    'how much is the gym',
    'is there wifi in the rooms',
    'can I get food at 2am',
    'what time does the spa close',
    'is there somewhere to work out',
    'when do I have to check out',
    'do you take amex',
    'is the hotel wheelchair accessible',
    'how far is the airport',
    'can I smoke on the balcony',
    'are kids allowed to stay free',
    'what is there to do nearby',
    'do you have a bar',
  ];

  const OUT_OF_SCOPE = [
    'What time does the casino open?',
    'Do you have a helipad?',
    'Is there a golf course?',
    'do you offer scuba diving lessons',
    'can you tell me tomorrow weather forecast',
  ];

  it('reports context for every in-scope phrasing in the battery', () => {
    for (const question of IN_SCOPE) {
      expect(retriever.search(question).hasContext, question).toBe(true);
    }
  });

  it('withholds context for things the hotel does not have or never mentions', () => {
    for (const question of OUT_OF_SCOPE) {
      expect(retriever.search(question).hasContext, question).toBe(false);
    }
  });

  it('does not let a wider topK turn an out-of-scope question into an answerable one', () => {
    // Coverage is a corpus-level measure, so it must not move with topK.
    for (const topK of [2, 4, 8, 20]) {
      const result = retriever.search('What time does the casino open?', { topK });
      expect(result.hasContext, `topK=${topK}`).toBe(false);
    }
  });

  it('still supplies context for a mixed question where part is answerable', () => {
    // We genuinely hold the Wi-Fi fact, so withholding context would be wrong.
    // Refusing only the casino half is the model's job, enforced by citations.
    const result = retriever.search('what is the wifi password for the casino');
    expect(result.hasContext).toBe(true);
    expect(result.scored[0]?.fact.id).toBe('F17');
  });

  it('withholds context for greetings and for questions with no content', () => {
    expect(retriever.search('hello there').hasContext).toBe(false);
    expect(retriever.search('is it good').hasContext).toBe(false);
  });

  it('accepts a strong single match even when coverage is dragged down by unknown words', () => {
    // "bring" appears nowhere in the corpus and, being unseen, carries maximum
    // IDF. Coverage alone would wrongly reject a near-perfect pet-policy match.
    const result = retriever.search('Can I bring my dog?');
    expect(result.confidence).toBeLessThan(CONTEXT_FLOOR);
    expect(result.strength).toBeGreaterThanOrEqual(0.5);
    expect(result.hasContext).toBe(true);
    expect(result.scored[0]?.fact.id).toBe('F34');
  });

  it('always supplies identity facts so the assistant knows which hotel it works for', () => {
    const result = retriever.search('Do you have a helipad?');
    const ids = [...result.facts, ...result.coreFacts].map((f) => f.id);
    expect(ids).toContain('F01');
    expect(ids).toContain('F03');
  });
});

describe('retrieval modes', () => {
  it('full mode puts the whole knowledge base in context, lexical mode narrows it', () => {
    const lexical = retriever.search('Is breakfast included?', { mode: 'lexical' });
    const full = retriever.search('Is breakfast included?', { mode: 'full' });
    expect(full.facts.length).toBeGreaterThan(lexical.facts.length);
    expect(lexical.facts.length).toBeLessThanOrEqual(8);
  });

  it('still refuses out-of-scope questions in full mode', () => {
    expect(retriever.search('What time does the casino open?', { mode: 'full' }).hasContext).toBe(false);
  });
});

describe('createRetriever', () => {
  it('works over an arbitrary fact set, so the index is not tied to this hotel', () => {
    const facts: Fact[] = [
      { id: 'X1', category: 'test', title: 'Rooftop cinema', text: 'There is a rooftop cinema.', tags: ['cinema', 'film'] },
      { id: 'X2', category: 'test', title: 'Library', text: 'There is a quiet library.', tags: ['library', 'books'] },
    ];
    const custom = createRetriever(facts);
    expect(custom.search('movie night cinema').scored[0]?.fact.id).toBe('X1');
    expect(custom.search('somewhere to read books').scored[0]?.fact.id).toBe('X2');
  });
});
