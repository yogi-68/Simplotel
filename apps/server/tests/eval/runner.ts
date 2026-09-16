import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createMockProvider } from '../../src/ai/mock.provider.js';
import { createOpenAiProvider } from '../../src/ai/openai.provider.js';
import { withResilience } from '../../src/ai/resilience.js';
import type { LlmProvider } from '../../src/ai/provider.js';
import { getEnv } from '../../src/config/env.js';
import { sessionStore } from '../../src/domain/conversation/session.store.js';
import { addDays, todayIso } from '../../src/lib/dates.js';
import { stubProvider, throwingProvider } from '../helpers/stubProvider.js';
import scenarioFile from './scenarios.json' with { type: 'json' };

/**
 * The evaluation harness.
 *
 * The same scenarios run two ways: against the offline mock, where they behave
 * as fast deterministic regression tests that anyone can run with no API key,
 * and against the real model with `--live`, where they measure whether an actual
 * LLM obeys the guardrails. Both matter. The first catches pipeline breakage in
 * CI; only the second tells you whether the prompt is doing its job.
 */

export interface ScenarioExpectation {
  status?: number;
  errorCode?: string;
  type?: string[];
  mustCite?: string[];
  mustContain?: string[];
  mustNotContain?: string[];
  mustNotMatch?: string;
  noSources?: boolean;
  grounded?: boolean;
  degraded?: boolean;
  toolCalled?: string;
  hasAvailability?: boolean;
  availabilityNights?: number;
  availabilityAvailable?: boolean;
  needs?: string[];
  slotsComplete?: boolean;
  maxConfidence?: number;
}

export interface Scenario {
  id: string;
  category: string;
  title: string;
  why: string;
  provider?: 'mock' | 'throwing' | 'uncited';
  turns: Array<{ message: string; context?: Record<string, unknown> }>;
  expect: ScenarioExpectation;
}

export interface ScenarioResult {
  scenario: Scenario;
  passed: boolean;
  failures: string[];
  finalReply: string;
  finalType: string;
  latencyMs: number;
}

export const scenarios = (scenarioFile as { scenarios: Scenario[] }).scenarios;

/** `{{+30}}` becomes the ISO date 30 days from today, so scenarios never expire. */
function resolveDates<T>(value: T): T {
  if (typeof value === 'string') {
    const match = /^\{\{\+(\d+)\}\}$/.exec(value);
    return (match ? addDays(todayIso(), Number(match[1])) : value) as T;
  }
  if (Array.isArray(value)) return value.map(resolveDates) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveDates(v)])) as T;
  }
  return value;
}

function providerFor(scenario: Scenario, live: boolean): LlmProvider {
  if (scenario.provider === 'throwing') return throwingProvider();
  if (scenario.provider === 'uncited') {
    // A model that answers fluently but cites nothing -- the exact failure the
    // citation validator exists to catch.
    return stubProvider([
      { answer: 'Check-in is at 9:00 AM and the rooftop casino opens at noon.', type: 'answer', sourceIds: [] },
    ]);
  }
  if (!live) return createMockProvider();

  const env = getEnv();
  return withResilience(
    createOpenAiProvider({ apiKey: env.OPENAI_API_KEY!, model: env.OPENAI_MODEL, timeoutMs: env.AI_TIMEOUT_MS }),
    { timeoutMs: env.AI_TIMEOUT_MS, maxRetries: env.AI_MAX_RETRIES },
  );
}

export async function runScenario(scenario: Scenario, opts: { live?: boolean } = {}): Promise<ScenarioResult> {
  const app = createApp({ provider: providerFor(scenario, opts.live ?? false) });
  const failures: string[] = [];
  const startedAt = Date.now();

  let sessionId: string | undefined;
  let body: Record<string, any> = {};
  let status = 0;

  for (const turn of scenario.turns) {
    const payload = resolveDates({ message: turn.message, sessionId, context: turn.context });
    const res = await request(app).post('/api/chat').send(payload);
    status = res.status;
    body = res.body;
    if (res.status !== 200) break;
    sessionId = res.body.sessionId;
  }

  // Conversations must not leak between scenarios.
  sessionStore.clear();

  const e = scenario.expect;
  const expectedStatus = e.status ?? 200;
  if (status !== expectedStatus) failures.push(`expected HTTP ${expectedStatus}, got ${status}`);

  if (e.errorCode) {
    if (body?.error?.code !== e.errorCode) failures.push(`expected error code ${e.errorCode}, got ${body?.error?.code}`);
  }

  if (status === 200 && expectedStatus === 200) {
    const text: string = body.reply?.text ?? '';
    const sourceIds: string[] = (body.sources ?? []).map((s: { id: string }) => s.id);

    if (e.type && !e.type.includes(body.reply?.type)) {
      failures.push(`expected type one of [${e.type.join(', ')}], got "${body.reply?.type}"`);
    }
    for (const id of e.mustCite ?? []) {
      if (!sourceIds.includes(id)) failures.push(`expected citation ${id}, got [${sourceIds.join(', ') || 'none'}]`);
    }
    for (const needle of e.mustContain ?? []) {
      if (!text.toLowerCase().includes(needle.toLowerCase())) failures.push(`reply should contain "${needle}"`);
    }
    for (const needle of e.mustNotContain ?? []) {
      if (text.toLowerCase().includes(needle.toLowerCase())) failures.push(`reply must not contain "${needle}"`);
    }
    if (e.mustNotMatch && new RegExp(e.mustNotMatch, 'i').test(text)) {
      failures.push(`reply must not match /${e.mustNotMatch}/i`);
    }
    if (e.noSources && sourceIds.length > 0) failures.push(`expected no sources, got [${sourceIds.join(', ')}]`);
    if (e.grounded !== undefined && body.meta?.grounded !== e.grounded) {
      failures.push(`expected grounded=${e.grounded}, got ${body.meta?.grounded}`);
    }
    if (e.degraded !== undefined && body.meta?.degraded !== e.degraded) {
      failures.push(`expected degraded=${e.degraded}, got ${body.meta?.degraded}`);
    }
    if (e.toolCalled && !(body.meta?.toolCalls ?? []).includes(e.toolCalled)) {
      failures.push(`expected tool ${e.toolCalled} to be called`);
    }
    if (e.hasAvailability !== undefined && Boolean(body.availability) !== e.hasAvailability) {
      failures.push(`expected availability payload ${e.hasAvailability ? 'present' : 'absent'}`);
    }
    if (e.availabilityNights !== undefined && body.availability?.query?.nights !== e.availabilityNights) {
      failures.push(`expected ${e.availabilityNights} nights, got ${body.availability?.query?.nights}`);
    }
    if (e.availabilityAvailable !== undefined && body.availability?.available !== e.availabilityAvailable) {
      failures.push(`expected available=${e.availabilityAvailable}, got ${body.availability?.available}`);
    }
    if (e.needs) {
      const actual: string[] = body.needs ?? [];
      const missing = e.needs.filter((n) => !actual.includes(n));
      if (missing.length > 0) failures.push(`expected needs to include [${missing.join(', ')}], got [${actual.join(', ')}]`);
    }
    if (e.slotsComplete) {
      const s = body.slots ?? {};
      if (!s.checkIn || !s.checkOut || s.adults === null) failures.push('expected all stay details to be filled');
    }
    if (e.maxConfidence !== undefined && (body.reply?.confidence ?? 1) > e.maxConfidence) {
      failures.push(`expected confidence <= ${e.maxConfidence}, got ${body.reply?.confidence}`);
    }
  }

  return {
    scenario,
    passed: failures.length === 0,
    failures,
    finalReply: body?.reply?.text ?? body?.error?.message ?? '',
    finalType: body?.reply?.type ?? (body?.error?.code as string) ?? 'n/a',
    latencyMs: Date.now() - startedAt,
  };
}
