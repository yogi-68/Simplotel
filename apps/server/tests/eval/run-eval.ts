/**
 * CLI entry point for the evaluation suite.
 *
 *   npm run eval                    offline, against the deterministic mock
 *   npm run eval -- --live          against the real model in .env
 *   npm run eval -- --mode=full     with the whole knowledge base in context
 *   npm run eval -- --json          machine-readable output for CI
 *   npm run eval -- --verbose       show every reply, not just failures
 *
 * The `--mode` flag is how the retrieval decision stays honest: the same
 * scenarios are scored under lexical retrieval and under full-context stuffing,
 * and the numbers go into EVALUATION.md rather than an assertion that one is
 * better.
 */

const args = process.argv.slice(2);
const live = args.includes('--live');
const asJson = args.includes('--json');
const verbose = args.includes('--verbose');
const modeArg = args.find((a) => a.startsWith('--mode='))?.split('=')[1];

// These must be set before anything that reads configuration is imported --
// ESM hoists static imports, so the application logger would otherwise be
// constructed at its configured level and flood the report. Hence the dynamic
// imports further down.
process.env.LOG_LEVEL = 'silent';
if (modeArg) process.env.RETRIEVAL_MODE = modeArg;
if (live) process.env.AI_PROVIDER = 'openai';

const GREEN = '[32m';
const RED = '[31m';
const DIM = '[2m';
const BOLD = '[1m';
const RESET = '[0m';

function pad(value: string, width: number): string {
  return value.length >= width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

async function main(): Promise<void> {
  const { resetEnvCache } = await import('../../src/config/env.js');
  resetEnvCache();

  if (live && !process.env.OPENAI_API_KEY) {
    console.error('\n  --live needs OPENAI_API_KEY in apps/server/.env\n');
    process.exit(1);
  }

  const { runScenario, scenarios } = await import('./runner.js');
  type Result = Awaited<ReturnType<typeof runScenario>>;

  const results: Result[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario, { live }));
  }

  const passed = results.filter((r) => r.passed).length;
  const retrieval = process.env.RETRIEVAL_MODE ?? 'lexical';

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          mode: live ? 'live' : 'mock',
          retrieval,
          passed,
          total: results.length,
          results: results.map((r) => ({
            id: r.scenario.id,
            title: r.scenario.title,
            category: r.scenario.category,
            passed: r.passed,
            failures: r.failures,
            reply: r.finalReply,
            latencyMs: r.latencyMs,
          })),
        },
        null,
        2,
      ),
    );
    process.exit(passed === results.length ? 0 : 1);
  }

  const provider = live ? `live openai (${process.env.OPENAI_MODEL ?? 'gpt-4o-mini'})` : 'mock (offline)';
  console.log(`\n${BOLD}Hotel guest assistant - evaluation${RESET}`);
  console.log(`${DIM}provider: ${provider}   retrieval: ${retrieval}${RESET}\n`);
  console.log(`${DIM}  ID     ${pad('CATEGORY', 22)}${pad('SCENARIO', 36)}RESULT${RESET}`);
  console.log(`${DIM}  ${'-'.repeat(74)}${RESET}`);

  for (const result of results) {
    const mark = result.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    console.log(
      `  ${pad(result.scenario.id, 7)}${pad(result.scenario.category, 22)}${pad(result.scenario.title, 36)}${mark}`,
    );
    if (!result.passed) {
      for (const failure of result.failures) console.log(`         ${RED}x ${failure}${RESET}`);
      console.log(`         ${DIM}got: ${result.finalReply.slice(0, 150)}${RESET}`);
    } else if (verbose) {
      console.log(`         ${DIM}${result.finalType}: ${result.finalReply.slice(0, 150)}${RESET}`);
    }
  }

  const avgLatency = Math.round(results.reduce((sum, r) => sum + r.latencyMs, 0) / results.length);
  console.log(`\n  ${passed === results.length ? GREEN : RED}${passed}/${results.length} scenarios passed${RESET}`);
  console.log(`  ${DIM}average ${avgLatency}ms per scenario${RESET}\n`);

  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
