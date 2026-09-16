import type { Source } from '@hotel/contracts';
import rawKb from './hotel-kb.json' with { type: 'json' };

export interface Fact {
  id: string;
  category: string;
  title: string;
  text: string;
  tags: string[];
}

export interface HotelProfile {
  name: string;
  tagline: string;
  city: string;
  address: string;
  phone: string;
  email: string;
  checkInTime: string;
  checkOutTime: string;
}

interface KnowledgeBase {
  hotel: HotelProfile;
  suggestedQuestions: string[];
  facts: Fact[];
}

const kb = rawKb as KnowledgeBase;

const factsById = new Map<string, Fact>(kb.facts.map((f) => [f.id, f]));

/**
 * Facts that are always in context regardless of the question.
 *
 * These are not retrieval results — they are the assistant's sense of self:
 * which hotel it works for, what rooms exist, and how to hand a guest over to a
 * human. Without them a question like "what is your address?" can retrieve
 * cleanly while the model still has no idea which property it represents.
 */
const CORE_FACT_IDS = ['F01', 'F03', 'F05'] as const;

export const knowledgeBase = {
  hotel(): HotelProfile {
    return kb.hotel;
  },

  facts(): Fact[] {
    return kb.facts;
  },

  suggestedQuestions(): string[] {
    return kb.suggestedQuestions;
  },

  get(id: string): Fact | undefined {
    return factsById.get(id);
  },

  /** The guard used by the citation validator: does this id exist at all? */
  has(id: string): boolean {
    return factsById.has(id);
  },

  coreFacts(): Fact[] {
    return CORE_FACT_IDS.map((id) => factsById.get(id)).filter((f): f is Fact => Boolean(f));
  },

  /** Shape a fact for the API response, where it becomes a tappable source chip. */
  toSource(fact: Fact): Source {
    return {
      id: fact.id,
      label: `${capitalise(fact.category)} / ${fact.title}`,
      text: fact.text,
    };
  },
};

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
