// Re-export so the vitest suite and the CLI share one implementation.
export { runScenario, scenarios } from './runner.js';
export type { Scenario, ScenarioResult } from './runner.js';
