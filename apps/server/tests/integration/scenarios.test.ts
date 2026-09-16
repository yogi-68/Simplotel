import { describe, expect, it } from 'vitest';
import { runScenario, scenarios } from '../eval/scenarios-bridge.js';

/**
 * The evaluation scenarios, run as part of the ordinary test suite.
 *
 * Keeping them here as well as behind `npm run eval` means a regression in
 * guardrail behaviour breaks CI like any other bug, rather than waiting for
 * someone to remember to run the eval report.
 */
describe('evaluation scenarios (offline)', () => {
  for (const scenario of scenarios) {
    it(`${scenario.id} ${scenario.category}: ${scenario.title}`, async () => {
      const result = await runScenario(scenario);
      expect(result.failures, `${scenario.why}\nreply: ${result.finalReply}`).toEqual([]);
      expect(result.passed).toBe(true);
    });
  }
});
