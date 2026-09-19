// @vitest-environment node
/**
 * CLI entry point for the deterministic prompt-guard eval.
 *
 *   npx tsx server/eval/run.ts
 *
 * Exits non-zero when a case fails, so a prompt regression can break a build
 * rather than just a test run someone has to notice.
 */

import { formatReport, runGuardEval } from './guardEval';

const report = runGuardEval();
const output = formatReport(report);

// eslint-disable-next-line no-console
console.log(output);

if (report.failed > 0) {
  process.exitCode = 1;
}
