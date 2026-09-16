import { NO_CONTEXT_MARKER } from './prompt.js';
import type { LlmCompletion, LlmMessage, LlmProvider, LlmRequest } from './provider.js';
import { CHECK_AVAILABILITY_TOOL } from './tools.js';
import type { AssistantOutput } from './schema.js';

/**
 * A deterministic stand-in for a language model.
 *
 * This exists so the entire application — server, tests, eval harness and the
 * web UI — runs with no API key and no network. That matters for three reasons:
 * anyone can clone the repo and get a green test suite immediately; the
 * integration tests assert on real behaviour instead of a hand-waved stub; and
 * CI never pays for or flakes on a model call.
 *
 * Crucially it does not cheat. It receives exactly the same messages a real
 * provider gets and answers by *reading the prompt* — parsing the fact block,
 * the no-context marker and the carried-over stay details. If the orchestrator
 * ever stopped putting the facts in the prompt, this provider would start
 * failing too, which makes it a useful canary rather than a rubber stamp.
 */

const FACT_LINE = /^\[(F\d+)\]\s+(.+)$/gm;
const SLOT_LINE = (field: string) => new RegExp(`^\\s*${field}:\\s*(.+)$`, 'm');

/**
 * The exact phrase the mock uses when it asks for missing stay details, and the
 * marker it looks for to know it is still waiting on them. Declared once so the
 * question and its detection can never drift apart.
 */
const STAY_DETAILS_PROMPT = 'Could you tell me';

const GREETING = /^\s*(hi|hello|hey|yo|good\s+(morning|afternoon|evening)|namaste)\b/i;
const THANKS = /\b(thanks|thank you|cheers|bye|goodbye)\b/i;

/** Verbs and nouns that mean "tell me if I can stay here". */
const AVAILABILITY_INTENT =
  /\b(availab\w*|vacan\w*|book\w*|reserv\w*|free\s+room|any\s+rooms?|rooms?\s+(for|on|free)|check\s+in\s+on|stay\s+from|nights?\s+in|how\s+much\s+(for|would)|quote|rates?\s+for)\b/i;

const DATE_HINT = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}(st|nd|rd|th)?\s+\w+|\w+\s+\d{1,2}|tomorrow|tonight|next\s+\w+)\b/i;
const ROOM_HINT = /\b(room|suite|night|stay|double|twin|king|queen)\b/i;

interface ParsedPrompt {
  facts: Array<{ id: string; text: string }>;
  hasContext: boolean;
  slots: { checkIn: string | null; checkOut: string | null; adults: number | null; children: number };
}

function parseSystemPrompt(system: string): ParsedPrompt {
  const facts: Array<{ id: string; text: string }> = [];
  FACT_LINE.lastIndex = 0;
  let match = FACT_LINE.exec(system);
  while (match !== null) {
    facts.push({ id: match[1]!, text: match[2]!.trim() });
    match = FACT_LINE.exec(system);
  }

  const readSlot = (field: string): string | null => {
    const found = system.match(SLOT_LINE(field));
    const value = found?.[1]?.trim();
    return !value || value === 'unknown' ? null : value;
  };

  const adultsRaw = readSlot('adults');
  const childrenRaw = readSlot('children');

  return {
    facts,
    hasContext: !system.includes(NO_CONTEXT_MARKER),
    slots: {
      checkIn: readSlot('checkIn'),
      checkOut: readSlot('checkOut'),
      adults: adultsRaw ? Number(adultsRaw) : null,
      children: childrenRaw ? Number(childrenRaw) : 0,
    },
  };
}

function wantsAvailability(text: string): boolean {
  if (AVAILABILITY_INTENT.test(text)) return true;
  // "a room on the 12th" carries the intent without an explicit verb.
  return DATE_HINT.test(text) && ROOM_HINT.test(text);
}

function output(partial: Partial<AssistantOutput> & Pick<AssistantOutput, 'answer' | 'type'>): string {
  const full: AssistantOutput = {
    sourceIds: [],
    confidence: 0.5,
    needs: [],
    suggestions: [],
    ...partial,
  };
  return JSON.stringify(full);
}

function formatInr(value: number): string {
  return `INR ${value.toLocaleString('en-IN')}`;
}

export function createMockProvider(): LlmProvider {
  return {
    name: 'mock',
    model: 'deterministic-rules-v1',

    async complete(request: LlmRequest): Promise<LlmCompletion> {
      const { messages } = request;
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const parsed = parseSystemPrompt(system);
      const last = messages[messages.length - 1];
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const question = lastUser?.content ?? '';

      // --- Turn 2 of a tool call: narrate whatever the engine returned. ------
      if (last?.role === 'tool') {
        return { content: narrateToolResult(last), toolCalls: [] };
      }

      // --- Availability intent ------------------------------------------------
      // Intent survives one turn, but only one. A guest who asked "do you have
      // rooms?" and is now answering with "those dates work" is still asking
      // about availability -- but that must not make every later message in the
      // conversation an availability request. The carry-over is therefore
      // conditional on the assistant's *immediately* preceding turn being the
      // clarification that asked for these details.
      const lastAssistantTurn = [...messages].reverse().find((m) => m.role === 'assistant');
      const awaitingStayDetails = lastAssistantTurn?.content.includes(STAY_DETAILS_PROMPT) ?? false;

      if (wantsAvailability(question) || awaitingStayDetails) {
        const { checkIn, checkOut, adults, children } = parsed.slots;
        if (checkIn && checkOut && adults) {
          return {
            content: null,
            toolCalls: [
              {
                id: 'mock-call-1',
                name: CHECK_AVAILABILITY_TOOL,
                arguments: { checkIn, checkOut, adults, children },
              },
            ],
          };
        }

        const needs: AssistantOutput['needs'] = [];
        if (!checkIn) needs.push('checkIn');
        if (!checkOut) needs.push('checkOut');
        if (!adults) needs.push('adults');

        const wording: Record<string, string> = {
          checkIn: 'your arrival date',
          checkOut: 'your departure date',
          adults: 'how many adults are staying',
        };
        // "a, b and c" rather than "a, b, c" -- the assistant is meant to read
        // like a person, and a comma-spliced list of questions does not.
        const phrases = needs.map((n) => wording[n]!);
        const asks =
          phrases.length > 1
            ? `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`
            : phrases[0]!;

        return {
          content: output({
            answer: `Happy to check that for you. ${STAY_DETAILS_PROMPT} ${asks}?`,
            type: 'clarification',
            needs,
            confidence: 0.9,
            suggestions: ['Is breakfast included?', 'What is the cancellation policy?'],
          }),
          toolCalls: [],
        };
      }

      // --- Nothing in the knowledge base covers this -------------------------
      if (!parsed.hasContext) {
        if (GREETING.test(question) || THANKS.test(question)) {
          return {
            content: output({
              answer: 'Hello, and welcome. I can help with questions about the hotel or check room availability for you.',
              type: 'smalltalk',
              confidence: 0.9,
              suggestions: ['What time is check-in?', 'Does the hotel have a swimming pool?'],
            }),
            toolCalls: [],
          };
        }
        return {
          content: output({
            answer:
              'I do not have that information, so I would rather not guess. The front desk will be able to help you with it directly.',
            type: 'fallback',
            confidence: 0.2,
            suggestions: ['What time is check-in?', 'Is breakfast included?'],
          }),
          toolCalls: [],
        };
      }

      // --- Grounded answer from the best-matching fact -----------------------
      const best = parsed.facts[0];
      if (!best) {
        return {
          content: output({
            answer: 'I do not have that detail to hand. The front desk can confirm it for you.',
            type: 'fallback',
            confidence: 0.2,
          }),
          toolCalls: [],
        };
      }

      return {
        content: output({
          answer: best.text,
          type: 'answer',
          sourceIds: [best.id],
          confidence: 0.85,
          suggestions: ['Do you have rooms available next weekend?', 'What is the cancellation policy?'],
        }),
        toolCalls: [],
      };
    },
  };
}

function narrateToolResult(toolMessage: LlmMessage): string {
  let payload: unknown;
  try {
    payload = JSON.parse(toolMessage.content);
  } catch {
    return output({
      answer: 'I could not read the availability response. Please try again in a moment.',
      type: 'fallback',
      confidence: 0.1,
    });
  }

  const result = payload as {
    error?: string;
    available?: boolean;
    options?: Array<{ name: string; total: number; roomsLeft: number }>;
    excluded?: Array<{ reason: string; explanation: string }>;
    query?: { nights: number; adults: number };
  };

  if (result.error) {
    return output({
      answer: `${result.error} Could you give me the corrected dates?`,
      type: 'clarification',
      needs: ['checkIn', 'checkOut'],
      confidence: 0.8,
    });
  }

  const options = result.options ?? [];
  if (!result.available || options.length === 0) {
    const reason = result.excluded?.[0]?.explanation;
    return output({
      answer: `I am sorry, we have nothing available for those dates.${reason ? ` ${reason}` : ''} Would you like me to try different dates?`,
      type: 'availability',
      confidence: 0.9,
      suggestions: ['Try the following weekend', 'What is the cancellation policy?'],
    });
  }

  const cheapest = options[0]!;
  const nights = result.query?.nights ?? 0;
  const plural = options.length === 1 ? 'option' : 'options';

  return output({
    answer:
      `Good news, we have ${options.length} ${plural} for your ${nights}-night stay. ` +
      `The ${cheapest.name} is the best value at ${formatInr(cheapest.total)} in total, including taxes and breakfast. ` +
      `Full details are in the cards below.`,
    type: 'availability',
    confidence: 0.95,
    suggestions: ['What is the cancellation policy?', 'Is parking included?'],
  });
}
