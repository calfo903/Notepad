/**
 * Best-effort detection of secrets and personal data in note text.
 *
 * This is a warning, not a filter. A regex cannot reliably tell a credit card
 * number from an order reference, so the design goal is to catch the things that
 * are *obviously* sensitive and let the user decide — not to silently redact and
 * produce a prompt that quietly means something different from what was written.
 *
 * False positives are acceptable. A missed API key is not.
 */

export type SensitiveKind =
  | 'private-key'
  | 'aws-key'
  | 'api-key'
  | 'jwt'
  | 'bearer-token'
  | 'card-number'
  | 'email';

export interface SensitiveFinding {
  readonly kind: SensitiveKind;
  /** Line number, 1-based, for pointing the user at the right place. */
  readonly line: number;
  /** A short, safe-to-display label. Never the matched value itself. */
  readonly label: string;
}

interface Pattern {
  readonly kind: SensitiveKind;
  readonly label: string;
  readonly regex: RegExp;
  /** Extra validation beyond the shape match. */
  readonly validate?: (match: string) => boolean;
}

const PATTERNS: readonly Pattern[] = [
  {
    kind: 'private-key',
    label: 'a private key block',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    kind: 'aws-key',
    label: 'an AWS access key ID',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    kind: 'api-key',
    label: 'an API key',
    // sk-/pk-/ghp_/xox- style secrets. Deliberately broad.
    regex: /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[baprs])-[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    kind: 'jwt',
    label: 'a signed token (JWT)',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    kind: 'bearer-token',
    label: 'a bearer token',
    regex: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/gi,
  },
  {
    kind: 'card-number',
    label: 'a payment card number',
    // 13-19 digits, optionally grouped by spaces or dashes.
    regex: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (match) => passesLuhn(match),
  },
  {
    kind: 'email',
    label: 'an email address',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
];

/** Luhn checksum. Rejects almost all accidental digit runs of the right length. */
export function passesLuhn(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;

  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }

  return sum % 10 === 0;
}

/**
 * Scan text and return what looks sensitive.
 *
 * Deduplicates by kind and line so a note full of email addresses produces one
 * warning rather than twenty.
 */
export function detectSensitiveContent(text: string): readonly SensitiveFinding[] {
  if (!text) return [];

  const lines = text.split('\n');
  const findings: SensitiveFinding[] = [];
  const seen = new Set<string>();

  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      // Reset lastIndex: these regexes are stateful and module-scoped.
      pattern.regex.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(line)) !== null) {
        if (pattern.validate && !pattern.validate(match[0])) continue;

        const key = `${pattern.kind}:${index}`;
        if (seen.has(key)) break;

        seen.add(key);
        findings.push({ kind: pattern.kind, line: index + 1, label: pattern.label });
        break;
      }
    }
  });

  return findings;
}

/**
 * Build a single human-readable warning.
 *
 * Names the kinds found without echoing any of the matched values, so the warning
 * itself cannot become the place the secret is displayed.
 */
export function describeFindings(findings: readonly SensitiveFinding[]): string {
  if (findings.length === 0) return '';

  const kinds = [...new Set(findings.map((finding) => finding.label))];
  const list =
    kinds.length === 1
      ? kinds[0]
      : `${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]}`;

  return `This note looks like it contains ${list}. It will be sent to the AI provider if you continue.`;
}
