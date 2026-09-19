// @vitest-environment node
/**
 * Deterministic prompt-guard evaluator.
 *
 * Runs every case in `cases.ts` through the real `hardenMessages` and scores the
 * declared expectations. No network, no API key, no cost — which is what makes it
 * safe to run on every pull request.
 *
 * This validates the *prompt*, not the model. A model can still disobey a perfect
 * prompt; that is what `liveEval.ts` is for.
 */

import { hardenMessages } from '../promptGuard';
import type { ChatMessageInput } from '../schema';
import { EVAL_CASES, type EvalCase, type ExpectationId } from './cases';

/** First line of the guard prompt. Stable enough to identify message zero. */
const GUARD_SIGNATURE = 'You are NoteFlow AI, a writing assistant embedded in a notepad application.';

const OPEN_RE = /<<<UNTRUSTED_([0-9a-f]{16})>>>/;
/** Everything of the close-marker shape, whatever nonce it claims. */
const ANY_CLOSE_RE = /<<<END_UNTRUSTED_[0-9a-f]{16}>>>/g;
/** C0 controls other than the newline and tab that hardening intentionally keeps. */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export interface ExpectationResult {
  readonly expectation: ExpectationId;
  readonly passed: boolean;
  /** Present when the check failed, so a failure explains itself. */
  readonly detail?: string;
}

export interface CaseResult {
  readonly id: string;
  readonly category: EvalCase['category'];
  readonly passed: boolean;
  readonly expectations: readonly ExpectationResult[];
}

export interface EvalReport {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly CaseResult[];
}

function extractNonce(prompt: readonly ChatMessageInput[]): string | undefined {
  return prompt[0]?.content.match(OPEN_RE)?.[1];
}

function allContent(prompt: readonly ChatMessageInput[]): string {
  return prompt.map((message) => message.content).join('\n');
}

function check(
  expectation: ExpectationId,
  testCase: EvalCase,
  prompt: readonly ChatMessageInput[]
): ExpectationResult {
  const fail = (detail: string): ExpectationResult => ({ expectation, passed: false, detail });
  const pass: ExpectationResult = { expectation, passed: true };

  const first = prompt[0];
  const joined = allContent(prompt);
  const nonce = extractNonce(prompt);

  switch (expectation) {
    case 'guard-is-first': {
      if (!first) return fail('hardened prompt is empty');
      if (first.role !== 'system') return fail(`message zero is ${first.role}, expected system`);
      if (!first.content.includes(GUARD_SIGNATURE)) return fail('message zero is not the guard prompt');
      return pass;
    }

    case 'no-client-system-before-guard': {
      // The guard is index zero by construction; what this really guards against
      // is a future refactor that prepends something else.
      if (!first?.content.includes(GUARD_SIGNATURE)) return fail('message zero is not the guard');
      return pass;
    }

    case 'no-forged-close-delimiter': {
      const found = [...new Set(joined.match(ANY_CLOSE_RE) ?? [])];
      if (found.length === 0) return fail('no close delimiter at all — note was never wrapped');
      const real = nonce ? `<<<END_UNTRUSTED_${nonce}>>>` : undefined;
      const forged = found.filter((marker) => marker !== real);
      if (forged.length > 0) return fail(`forged close delimiter(s) survived: ${forged.join(', ')}`);
      return pass;
    }

    case 'nonce-in-delimiters': {
      if (!nonce) return fail('guard contains no nonce-delimited marker');
      if (!joined.includes(`<<<END_UNTRUSTED_${nonce}>>>`)) {
        return fail('open marker nonce does not match the close marker');
      }
      return pass;
    }

    case 'no-control-characters': {
      const offender = prompt.find((message) => CONTROL_RE.test(message.content));
      if (offender) {
        const at = offender.content.search(CONTROL_RE);
        return fail(`control character U+${offender.content.charCodeAt(at).toString(16).padStart(4, '0')} survived`);
      }
      return pass;
    }

    case 'note-is-marked-untrusted': {
      if (!nonce) return fail('no nonce available');
      const wrapped = prompt.some(
        (message) =>
          message.content.includes(`<<<UNTRUSTED_${nonce}>>>`) &&
          message.content.includes(`<<<END_UNTRUSTED_${nonce}>>>`)
      );
      if (!wrapped) return fail('note content was not wrapped in untrusted markers');
      return pass;
    }

    case 'benign-content-preserved': {
      const missing = (testCase.mustContain ?? []).filter((needle) => !joined.includes(needle));
      if (missing.length > 0) return fail(`hardening removed: ${missing.join(' | ')}`);
      return pass;
    }

    case 'app-system-retained': {
      const appSystems = prompt.filter(
        (message, index) => index > 0 && message.role === 'system'
      );
      if (appSystems.length === 0) return fail('client system messages were dropped entirely');
      return pass;
    }

    default: {
      const exhaustive: never = expectation;
      return fail(`unimplemented expectation: ${String(exhaustive)}`);
    }
  }
}

export function runGuardEval(cases: readonly EvalCase[] = EVAL_CASES): EvalReport {
  const results = cases.map((testCase) => {
    const prompt = hardenMessages(testCase.messages, testCase.noteContent);
    const joined = allContent(prompt);

    const expectations: ExpectationResult[] = [
      ...testCase.expectations.map((expectation) => check(expectation, testCase, prompt)),
      // Applied to every case regardless of what it declares: these are the
      // absolute invariants, and a case that forgot to list them should still fail.
      ...(testCase.mustNotContain ?? [])
        .filter((forbidden) => joined.includes(forbidden))
        .map((forbidden) => ({
          expectation: 'no-forged-close-delimiter' as const,
          passed: false,
          detail: `forbidden string survived hardening: ${forbidden}`,
        })),
    ];

    return {
      id: testCase.id,
      category: testCase.category,
      passed: expectations.every((result) => result.passed),
      expectations,
    };
  });

  return {
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    results,
  };
}

/** Render the report as text for CI logs. Failures only, to keep it scannable. */
export function formatReport(report: EvalReport): string {
  const lines = [
    `prompt-guard eval: ${report.passed}/${report.total} cases passed, ${report.failed} failed`,
  ];

  for (const result of report.results.filter((candidate) => !candidate.passed)) {
    lines.push(`  FAIL ${result.id} (${result.category})`);
    for (const expectation of result.expectations.filter((candidate) => !candidate.passed)) {
      lines.push(`       ${expectation.expectation}: ${expectation.detail ?? 'failed'}`);
    }
  }

  return lines.join('\n');
}
