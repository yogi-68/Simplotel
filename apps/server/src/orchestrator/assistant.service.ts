import type {
  AvailabilityResult,
  ChatRequest,
  ChatResponse,
  SlotName,
  Slots,
  Source,
} from '@hotel/contracts';
import { AvailabilityQuerySchema } from '@hotel/contracts';
import { getEnv } from '../config/env.js';
import { AssistantOutputSchema, type AssistantOutput } from '../ai/schema.js';
import { buildMessages } from '../ai/prompt.js';
import type { LlmMessage, LlmProvider, LlmToolCall } from '../ai/provider.js';
import { CHECK_AVAILABILITY_TOOL, allTools } from '../ai/tools.js';
import { checkAvailability } from '../domain/availability/availability.service.js';
import { knowledgeBase, type Fact } from '../domain/knowledge/kb.repository.js';
import { retriever as defaultRetriever, type Retriever } from '../domain/knowledge/retriever.js';
import {
  hasCompleteStay,
  mergeSlots,
  missingSlots,
  slotsFromRequestContext,
  slotsFromToolArguments,
} from '../domain/conversation/slots.js';
import { sessionStore as defaultSessionStore, type SessionStore } from '../domain/conversation/session.store.js';
import { todayIso } from '../lib/dates.js';
import { AppError, isAppError } from '../lib/errors.js';
import { logger, truncate } from '../lib/logger.js';
import { validateCitations } from './grounding.js';
import { tokenize } from '../domain/knowledge/tokenizer.js';

/**
 * The turn pipeline.
 *
 * retrieve -> prompt -> model -> (validate tool args -> engine -> model) ->
 * parse -> validate citations -> envelope
 *
 * The division of labour is the whole point of this file. The model handles the
 * parts that are genuinely language problems: what is this guest asking, what do
 * these facts mean together, what did "it" refer to, what date is "next Friday".
 * Everything with a right answer -- date validity, occupancy limits, pricing,
 * tax slabs, whether a citation is real -- is computed here in ordinary code,
 * before or after the model runs, and the model is never asked to agree with it.
 */

/** Tool iterations per turn. Two is enough for call-then-narrate; more is a loop. */
const MAX_TOOL_ITERATIONS = 2;

/** Short follow-ups like "and checkout?" need the previous turn to retrieve well. */
const FOLLOW_UP_TOKEN_THRESHOLD = 4;

export interface AssistantDeps {
  provider: LlmProvider;
  retriever?: Retriever;
  sessions?: SessionStore;
  today?: () => string;
}

export interface HandleChatInput {
  request: ChatRequest;
  requestId: string;
  signal?: AbortSignal;
}

export async function handleChat(input: HandleChatInput, deps: AssistantDeps): Promise<ChatResponse> {
  const env = getEnv();
  const retriever = deps.retriever ?? defaultRetriever;
  const sessions = deps.sessions ?? defaultSessionStore;
  const today = (deps.today ?? todayIso)();
  const startedAt = Date.now();

  const session = sessions.resolve(input.request.sessionId);

  // Structured form input outranks anything remembered from conversation.
  let slots = mergeSlots(session.slots, slotsFromRequestContext(input.request.context));

  const retrieval = retrieveForTurn(retriever, input.request.message, session.turns, env.RETRIEVAL_MODE);
  const contextFacts: Fact[] = [...retrieval.facts, ...retrieval.coreFacts];

  const messages = buildMessages({
    hotel: knowledgeBase.hotel(),
    facts: retrieval.facts,
    coreFacts: retrieval.coreFacts,
    hasContext: retrieval.hasContext,
    slots,
    today,
    history: session.turns,
    message: input.request.message,
  });

  const toolCallNames: string[] = [];
  let availability: AvailabilityResult | null = null;
  let output: AssistantOutput | null = null;
  let degraded = false;
  let parseFailed = false;
  let ruleFailure: { message: string; field: string | null } | null = null;

  // When the request itself carries a complete stay, the guest filled a date
  // picker and pressed "Check availability". There is no intent left to infer,
  // so we run the engine ourselves and hand the model the result to narrate
  // rather than asking it to decide whether to look anything up.
  //
  // This is not an optimisation. Live evaluation showed gpt-4o-mini ignoring the
  // stay details in its prompt and asking the guest to repeat dates they had
  // just entered -- on the single most important path in the product. Leaving a
  // deterministic decision to a language model was the bug; taking it back is
  // the fix, and it makes this path independent of which model is behind it.
  const preseed = preseedAvailability(input.request.context, { today, requestId: input.requestId });
  if (preseed) {
    messages.push(preseed.assistantMessage, preseed.toolMessage);
  }

  try {
    const run = await runModelLoop({
      provider: deps.provider,
      messages,
      signal: input.signal,
      today,
      slots: preseed?.availability ? mergeSlots(slots, slotsFromToolArguments(preseed.args)) : slots,
      requestId: input.requestId,
      seededAvailability: preseed?.availability ?? null,
      seededToolCalls: preseed ? [CHECK_AVAILABILITY_TOOL] : [],
      seededRuleFailure: preseed?.ruleFailure ?? null,
    });
    output = run.output;
    availability = run.availability;
    slots = run.slots;
    toolCallNames.push(...run.toolCallNames);
    parseFailed = run.parseFailed;
    ruleFailure = run.ruleFailure;
  } catch (error) {
    // The model is unreachable. We do NOT fail the request -- we answer from
    // the knowledge base directly. A guest asking about check-in time should
    // still get 2:00 PM when OpenAI is having a bad day.
    degraded = true;
    logger.error(
      { requestId: input.requestId, err: error instanceof Error ? error.message : String(error) },
      'AI provider unavailable, serving degraded retrieval-only answer',
    );
    output = buildDegradedOutput(retrieval.scored[0]?.fact);
  }

  const verdict = validateCitations(output, contextFacts);

  let reply = output;
  let grounded = verdict.grounded;
  let sources: Source[] = verdict.sources;

  if (verdict.violation) {
    // The model made a factual claim it could not support. Discard it entirely
    // rather than show the guest something we cannot stand behind.
    logger.warn(
      {
        requestId: input.requestId,
        violation: verdict.violation,
        unknownIds: verdict.unknownIds,
        question: truncate(input.request.message),
        discarded: truncate(output.answer, 200),
      },
      'Grounding violation: replacing unsupported answer with fallback',
    );
    reply = buildUngroundedFallback();
    grounded = false;
    sources = [];
  }

  if (parseFailed) {
    logger.warn({ requestId: input.requestId }, 'Model output failed schema validation, served fallback');
  }

  // A rejected stay is a clarification, and the backend already knows that -- so
  // it does not get left to the model. Live runs showed gpt-4o-mini labelling
  // "your check-out is before your check-in" as `fallback`, which the UI badges
  // "Not in our records". That is actively misleading: our records are fine, the
  // guest's dates are not. The model's wording is kept; only the label is fixed.
  if (ruleFailure && !degraded && reply.type !== 'clarification') {
    logger.info(
      { requestId: input.requestId, was: reply.type, field: ruleFailure.field },
      'Relabelled reply as clarification after a business-rule failure',
    );
    reply = { ...reply, type: 'clarification' };
  }

  const needs = resolveNeeds(reply, slots, ruleFailure?.field ?? null);
  const confidence = blendConfidence(reply, retrieval.confidence, retrieval.strength, degraded);

  const response: ChatResponse = {
    ok: true,
    requestId: input.requestId,
    sessionId: session.id,
    reply: { text: reply.answer, type: reply.type, confidence },
    sources,
    availability,
    slots,
    needs,
    suggestions: pickSuggestions(reply.suggestions, input.request.message),
    meta: {
      provider: deps.provider.name,
      model: deps.provider.model,
      latencyMs: Date.now() - startedAt,
      toolCalls: toolCallNames,
      grounded,
      degraded,
    },
  };

  sessions.append(session, { role: 'user', content: input.request.message }, { role: 'assistant', content: reply.answer });
  sessions.updateSlots(session, slots);

  logger.info(
    {
      requestId: input.requestId,
      sessionId: session.id,
      provider: deps.provider.name,
      type: reply.type,
      grounded,
      degraded,
      confidence,
      retrievalConfidence: Number(retrieval.confidence.toFixed(2)),
      retrievalStrength: Number(retrieval.strength.toFixed(2)),
      hasContext: retrieval.hasContext,
      toolCalls: toolCallNames,
      sourceIds: sources.map((s) => s.id),
      latencyMs: response.meta.latencyMs,
      question: truncate(input.request.message),
    },
    'chat turn completed',
  );

  return response;
}

// ---------------------------------------------------------------------------
// Model loop
// ---------------------------------------------------------------------------

interface ModelLoopInput {
  provider: LlmProvider;
  messages: LlmMessage[];
  signal?: AbortSignal;
  today: string;
  slots: Slots;
  requestId: string;
  /** Engine result computed before the model ran, for the structured-form path. */
  seededAvailability?: AvailabilityResult | null;
  seededToolCalls?: string[];
  seededRuleFailure?: { message: string; field: string | null } | null;
}

interface ModelLoopResult {
  output: AssistantOutput;
  availability: AvailabilityResult | null;
  slots: Slots;
  toolCallNames: string[];
  parseFailed: boolean;
  /** Set when the engine rejected the stay, so the reply can be labelled correctly. */
  ruleFailure: { message: string; field: string | null } | null;
}

async function runModelLoop(input: ModelLoopInput): Promise<ModelLoopResult> {
  const messages = [...input.messages];
  const toolCallNames: string[] = [...(input.seededToolCalls ?? [])];
  let availability: AvailabilityResult | null = input.seededAvailability ?? null;
  let ruleFailure = input.seededRuleFailure ?? null;
  let slots = input.slots;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    const completion = await input.provider.complete({ messages, tools: allTools, signal: input.signal });

    if (completion.toolCalls.length === 0) {
      const parsed = parseOutput(completion.content);
      return { output: parsed.output, availability, slots, toolCallNames, parseFailed: parsed.failed, ruleFailure };
    }

    messages.push({ role: 'assistant', content: completion.content ?? '', toolCalls: completion.toolCalls });

    for (const call of completion.toolCalls) {
      toolCallNames.push(call.name);
      const execution = executeTool(call, { today: input.today, requestId: input.requestId });
      if (execution.ruleFailure) ruleFailure = execution.ruleFailure;
      if (execution.availability) {
        availability = execution.availability;
        // Trust the arguments only once the engine has accepted them.
        slots = mergeSlots(slots, slotsFromToolArguments(call.arguments));
      }
      messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(execution.payload) });
    }
  }

  // The model kept asking for tools. Rather than loop, answer from what we have.
  logger.warn({ requestId: input.requestId }, 'Tool iteration limit reached');
  return {
    output: availability
      ? {
          answer: 'Here is what I found for those dates.',
          type: 'availability',
          sourceIds: [],
          confidence: 0.8,
          needs: [],
          suggestions: [],
        }
      : buildUngroundedFallback(),
    availability,
    slots,
    toolCallNames,
    parseFailed: false,
    ruleFailure,
  };
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

const PRESEED_TOOL_CALL_ID = 'preflight-availability';

/**
 * Run `check_availability` up front when the request already carries a complete
 * stay, and shape the result as a tool exchange the model can narrate.
 *
 * Only the booking form sends a complete `context`; a typed message sends none.
 * So this fires exactly when the guest has expressed their stay through a date
 * picker, and never hijacks an unrelated question asked while the form happens
 * to be filled in.
 *
 * A stay that breaks a business rule is seeded too, as a tool *error*. The model
 * then asks the guest to correct it, which is the same path an invalid
 * model-generated tool call takes -- one behaviour, one place.
 */
function preseedAvailability(
  context: ChatRequest['context'],
  ctx: { today: string; requestId: string },
): {
  assistantMessage: LlmMessage;
  toolMessage: LlmMessage;
  availability: AvailabilityResult | null;
  args: Record<string, unknown>;
  ruleFailure: { message: string; field: string | null } | null;
} | null {
  if (!context?.checkIn || !context.checkOut || context.adults === undefined) return null;

  const args: Record<string, unknown> = {
    checkIn: context.checkIn,
    checkOut: context.checkOut,
    adults: context.adults,
    children: context.children ?? 0,
  };

  const execution = executeTool(
    { id: PRESEED_TOOL_CALL_ID, name: CHECK_AVAILABILITY_TOOL, arguments: args },
    ctx,
  );

  return {
    assistantMessage: {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: PRESEED_TOOL_CALL_ID, name: CHECK_AVAILABILITY_TOOL, arguments: args }],
    },
    toolMessage: { role: 'tool', toolCallId: PRESEED_TOOL_CALL_ID, content: JSON.stringify(execution.payload) },
    availability: execution.availability,
    args,
    ruleFailure: execution.ruleFailure,
  };
}

interface ToolExecution {
  /** Compact payload handed back to the model for narration. */
  payload: unknown;
  /** Full engine result, attached to the API response for the UI. */
  availability: AvailabilityResult | null;
  /** Set when a business rule rejected the arguments, with the offending field. */
  ruleFailure: { message: string; field: string | null } | null;
}

function executeTool(call: LlmToolCall, ctx: { today: string; requestId: string }): ToolExecution {
  if (call.name !== CHECK_AVAILABILITY_TOOL) {
    return { payload: { error: `Unknown tool ${call.name}.` }, availability: null, ruleFailure: null };
  }

  // Tool arguments come from a language model, so they are untrusted input and
  // get the same treatment as anything arriving over HTTP.
  const parsed = AvailabilityQuerySchema.safeParse(call.arguments);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.join('.') ?? null;
    const message = `Those stay details are not usable: ${first?.message ?? 'invalid arguments'}.`;
    return { payload: { error: message, field }, availability: null, ruleFailure: { message, field } };
  }

  try {
    const result = checkAvailability(parsed.data, { today: ctx.today });
    return { payload: compactForModel(result), availability: result, ruleFailure: null };
  } catch (error) {
    if (isAppError(error) && error.code === 'VALIDATION_ERROR') {
      // A broken business rule (past date, checkout before checkin) is not a
      // server error -- it is information the guest needs. Hand it back to the
      // model so it can ask for a correction in its own words.
      const field = error.details?.[0]?.path ?? null;
      return {
        payload: { error: error.message, field },
        availability: null,
        ruleFailure: { message: error.message, field },
      };
    }
    logger.error({ requestId: ctx.requestId, err: String(error) }, 'Availability tool failed');
    return { payload: { error: 'Availability could not be checked right now.' }, availability: null, ruleFailure: null };
  }
}

/**
 * Give the model the shape of the result, not every number in it.
 *
 * The exact prices and per-night breakdowns are rendered by the UI from the
 * structured object, so putting them in the prompt only adds tokens and gives
 * the model more figures to misquote. It gets totals and counts, which is all it
 * needs to write one honest sentence.
 */
function compactForModel(result: AvailabilityResult) {
  return {
    query: result.query,
    available: result.available,
    currency: result.currency,
    options: result.options.map((o) => ({
      name: o.name,
      roomsLeft: o.roomsLeft,
      total: o.total,
      perNightAverage: o.perNightAverage,
      maxAdults: o.maxAdults,
    })),
    excluded: result.excluded.map((e) => ({ name: e.name, reason: e.reason, explanation: e.explanation })),
    notes: result.notes,
  };
}

// ---------------------------------------------------------------------------
// Output handling
// ---------------------------------------------------------------------------

function parseOutput(content: string | null): { output: AssistantOutput; failed: boolean } {
  if (!content) return { output: buildUngroundedFallback(), failed: true };

  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { output: buildUngroundedFallback(), failed: true };
  }

  const parsed = AssistantOutputSchema.safeParse(json);
  if (!parsed.success) return { output: buildUngroundedFallback(), failed: true };

  return { output: parsed.data, failed: false };
}

/** The honest "I do not know" reply. Used for refusals and for discarded answers. */
function buildUngroundedFallback(): AssistantOutput {
  const hotel = knowledgeBase.hotel();
  return {
    answer:
      `I do not have that information in my records, and I would rather not guess. ` +
      `Our front desk can confirm it for you on ${hotel.phone}.`,
    type: 'fallback',
    sourceIds: [],
    confidence: 0.2,
    needs: [],
    suggestions: ['What time is check-in?', 'Is breakfast included?'],
  };
}

/**
 * What the guest gets when the model is down.
 *
 * Note this is still a real answer, not an error page: the retrieved fact is
 * returned verbatim. The feature keeps working without the LLM, which is the
 * point of keeping the knowledge base outside it.
 */
function buildDegradedOutput(topFact: Fact | undefined): AssistantOutput {
  const hotel = knowledgeBase.hotel();
  if (!topFact) {
    return {
      answer:
        `Our assistant is temporarily unavailable and I could not find this in our records. ` +
        `Please call the front desk on ${hotel.phone} and they will help you straight away.`,
      type: 'handoff',
      sourceIds: [],
      confidence: 0.1,
      needs: [],
      suggestions: [],
    };
  }
  return {
    answer: `Our assistant is temporarily unavailable, but here is what our records show. ${topFact.text}`,
    type: 'answer',
    sourceIds: [topFact.id],
    confidence: 0.5,
    needs: [],
    suggestions: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Retrieval for one turn, including the follow-up rescue.
 *
 * Follow-ups are short and referential ("and checkout?", "how much?"), and on
 * their own they retrieve badly, so we widen the query with the previous guest
 * turn. That widening is strictly a rescue, and it is fenced in two ways:
 *
 *  - It only runs when the message *failed* to retrieve on its own. A question
 *    that already found its facts is never diluted with an older topic.
 *  - It never runs when the guest used a word the corpus has never seen. A short
 *    message like "what time does the casino open?" is not an under-specified
 *    follow-up, it is a new topic we cannot answer -- and borrowing "dates" from
 *    the previous turn would have lifted it over the context floor and turned an
 *    honest refusal into an answer about something else entirely.
 */
function retrieveForTurn(
  retriever: Retriever,
  message: string,
  turns: Array<{ role: string; content: string }>,
  mode: 'lexical' | 'full',
) {
  const standalone = retriever.search(message, { mode });
  if (standalone.hasContext) return standalone;
  if (tokenize(message).length > FOLLOW_UP_TOKEN_THRESHOLD) return standalone;
  if (retriever.unknownTerms(message).length > 0) return standalone;

  const previousUserTurn = [...turns].reverse().find((t) => t.role === 'user');
  if (!previousUserTurn) return standalone;

  const widened = retriever.search(`${previousUserTurn.content} ${message}`, { mode });
  return widened.hasContext ? widened : standalone;
}

/**
 * `needs` drives the inline booking form, so it must reflect what is actually
 * missing -- not merely what the model remembered to ask for.
 */
const SLOT_NAMES: SlotName[] = ['checkIn', 'checkOut', 'adults'];

function resolveNeeds(output: AssistantOutput, slots: Slots, failedField: string | null): SlotName[] {
  if (output.type !== 'clarification') return [];

  // A field the engine rejected is "needed" even though it has a value -- the
  // guest supplied a date, it is just not a usable one, and the form should
  // point at exactly that input.
  const rejected = SLOT_NAMES.find((name) => name === failedField);
  if (rejected) return [rejected];

  const actuallyMissing = missingSlots(slots);
  if (actuallyMissing.length === 0) return [];
  // Intersect so we never ask for something we already know, but fall back to
  // the computed set when the model listed nothing useful.
  const modelAsked = output.needs.filter((n) => actuallyMissing.includes(n));
  return modelAsked.length > 0 ? modelAsked : actuallyMissing;
}

/**
 * A model saying "I am 95% sure" means little on its own. For factual answers we
 * temper it with how well the knowledge base actually covered the question, so
 * the number shown to the guest reflects evidence rather than fluency.
 */
function blendConfidence(
  output: AssistantOutput,
  retrievalConfidence: number,
  retrievalStrength: number,
  degraded: boolean,
): number {
  const round = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
  if (degraded) return round(Math.min(output.confidence, 0.5));
  // Availability numbers are computed, not generated, so they are exact.
  if (output.type === 'availability') return 0.95;
  if (output.type === 'fallback') return round(Math.min(output.confidence, 0.3));
  if (output.type === 'answer') {
    const evidence = Math.max(retrievalConfidence, retrievalStrength);
    return round(0.4 * evidence + 0.6 * output.confidence);
  }
  return round(output.confidence);
}

/** Never suggest the question the guest just asked. */
function pickSuggestions(modelSuggestions: string[], question: string): string[] {
  const asked = question.trim().toLowerCase();
  const fromModel = modelSuggestions.map((s) => s.trim()).filter((s) => s.length > 0 && s.toLowerCase() !== asked);
  if (fromModel.length > 0) return fromModel.slice(0, 3);
  return knowledgeBase
    .suggestedQuestions()
    .filter((q) => q.toLowerCase() !== asked)
    .slice(0, 3);
}

export function hasStayDetails(slots: Slots): boolean {
  return hasCompleteStay(slots);
}
