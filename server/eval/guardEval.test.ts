// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { runGuardEval } from './guardEval';
import { EVAL_CASES } from './cases';

const report = runGuardEval();

describe('prompt-guard eval suite', () => {
  it('has enough cases across categories to be worth running', () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(15);

    const categories = new Set(EVAL_CASES.map((testCase) => testCase.category));
    expect(categories.size).toBeGreaterThanOrEqual(6);
  });

  it('every case declares at least one expectation', () => {
    for (const testCase of EVAL_CASES) {
      expect(testCase.expectations.length, `${testCase.id} declares nothing`).toBeGreaterThan(0);
    }
  });

  it('case ids are unique', () => {
    const ids = EVAL_CASES.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // One test per case, so a regression names the attack rather than "the suite".
  it.each(EVAL_CASES.map((testCase) => [testCase.id, testCase] as const))(
    'case %s passes its declared expectations',
    (_id, testCase) => {
      const result = report.results.find((candidate) => candidate.id === testCase.id);

      const failures = (result?.expectations ?? [])
        .filter((expectation) => !expectation.passed)
        .map((expectation) => `${expectation.expectation}: ${expectation.detail}`);

      expect(failures, `${testCase.id} failed:\n${failures.join('\n')}`).toEqual([]);
    }
  );

  it('the whole suite is green', () => {
    expect(report.failed, `${report.failed} case(s) failed`).toBe(0);
    expect(report.passed).toBe(report.total);
  });
});
