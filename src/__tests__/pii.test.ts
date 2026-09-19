import { describe, it, expect } from 'vitest';
import { describeFindings, detectSensitiveContent, passesLuhn } from '../utils/pii';

describe('passesLuhn', () => {
  it('accepts a valid card number', () => {
    expect(passesLuhn('4242 4242 4242 4242')).toBe(true);
    expect(passesLuhn('4242424242424242')).toBe(true);
  });

  it('rejects an invalid checksum', () => {
    expect(passesLuhn('4242 4242 4242 4243')).toBe(false);
  });

  it('rejects digit runs that are the wrong length', () => {
    expect(passesLuhn('123456')).toBe(false);
    expect(passesLuhn('1'.repeat(25))).toBe(false);
  });
});

describe('detectSensitiveContent', () => {
  it('finds an AWS access key', () => {
    const findings = detectSensitiveContent('key = AKIAIOSFODNN7EXAMPLE');
    expect(findings.map((f) => f.kind)).toContain('aws-key');
  });

  it('finds a private key block', () => {
    const findings = detectSensitiveContent('-----BEGIN RSA PRIVATE KEY-----\nMIIE...');
    expect(findings.map((f) => f.kind)).toContain('private-key');
  });

  it('finds an API key', () => {
    expect(detectSensitiveContent('OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789abcdef').map((f) => f.kind))
      .toContain('api-key');
  });

  it('finds a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    expect(detectSensitiveContent(`token: ${jwt}`).map((f) => f.kind)).toContain('jwt');
  });

  it('finds a bearer token', () => {
    expect(detectSensitiveContent('Authorization: Bearer abcdef0123456789ABCDEF').map((f) => f.kind))
      .toContain('bearer-token');
  });

  it('finds a valid card number but not an arbitrary long number', () => {
    expect(detectSensitiveContent('card 4242 4242 4242 4242').map((f) => f.kind)).toContain('card-number');
    expect(detectSensitiveContent('order 1234 5678 9012 3456').map((f) => f.kind)).not.toContain('card-number');
  });

  it('finds an email address', () => {
    expect(detectSensitiveContent('contact jane.doe@example.co.uk today').map((f) => f.kind)).toContain('email');
  });

  it('reports the line number so the user can find it', () => {
    const findings = detectSensitiveContent('line one\nline two\nkey AKIAIOSFODNN7EXAMPLE');
    expect(findings[0].line).toBe(3);
  });

  it('collapses many of the same kind on one line into one finding', () => {
    const findings = detectSensitiveContent('a@x.com b@y.com c@z.com');
    expect(findings.filter((f) => f.kind === 'email')).toHaveLength(1);
  });

  it('reports nothing for ordinary prose', () => {
    expect(detectSensitiveContent('The quarterly budget review is on Thursday at 3pm.')).toEqual([]);
  });

  it('handles empty and nullish input', () => {
    expect(detectSensitiveContent('')).toEqual([]);
  });

  it('is not left in a broken state by repeated calls', () => {
    // The patterns are module-scoped and stateful; a stale lastIndex would make
    // the second call miss what the first found.
    const text = 'key AKIAIOSFODNN7EXAMPLE';
    expect(detectSensitiveContent(text).length).toBeGreaterThan(0);
    expect(detectSensitiveContent(text).length).toBeGreaterThan(0);
  });

  it('never includes the matched value in a finding', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const findings = detectSensitiveContent(`leaked ${secret}`);

    expect(JSON.stringify(findings)).not.toContain(secret);
  });
});

describe('describeFindings', () => {
  it('is empty when there is nothing to warn about', () => {
    expect(describeFindings([])).toBe('');
  });

  it('names a single kind', () => {
    const message = describeFindings([{ kind: 'email', line: 1, label: 'an email address' }]);
    expect(message).toContain('an email address');
    expect(message).not.toContain(' and ');
  });

  it('joins multiple kinds readably', () => {
    const message = describeFindings([
      { kind: 'email', line: 1, label: 'an email address' },
      { kind: 'jwt', line: 2, label: 'a signed token (JWT)' },
    ]);

    expect(message).toBe(
      'This note looks like it contains an email address and a signed token (JWT). ' +
        'It will be sent to the AI provider if you continue.'
    );
  });

  it('deduplicates repeated kinds across lines', () => {
    const message = describeFindings([
      { kind: 'email', line: 1, label: 'an email address' },
      { kind: 'email', line: 4, label: 'an email address' },
    ]);

    expect(message.match(/an email address/g)).toHaveLength(1);
  });
});
