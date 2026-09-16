import { describe, it, expect, beforeEach } from 'vitest';
import {
  escapeHtml,
  sanitizeHtml,
  renderInlineMarkdown,
  plainTextToHtml,
  isSafeUrl,
  resetSanitizerForTests,
} from '../utils/sanitize';
import { stripHtml, textToHtml } from '../utils/helpers';

describe('sanitize', () => {
  beforeEach(() => {
    resetSanitizerForTests();
  });

  describe('escapeHtml', () => {
    it('escapes every character that can break out of a text context', () => {
      expect(escapeHtml(`<img src="x" onerror='alert(1)'>&`)).toBe(
        '&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;'
      );
    });

    it('returns an empty string for empty, null and undefined input', () => {
      expect(escapeHtml('')).toBe('');
      expect(escapeHtml(null as unknown as string)).toBe('');
      expect(escapeHtml(undefined as unknown as string)).toBe('');
    });

    it('leaves text without markup untouched', () => {
      expect(escapeHtml('plain text 123 - ok')).toBe('plain text 123 - ok');
    });
  });

  describe('sanitizeHtml', () => {
    it('removes script elements entirely', () => {
      const out = sanitizeHtml('<p>ok</p><script>window.__pwned = true</script>');
      expect(out).toBe('<p>ok</p>');
      expect(out).not.toContain('script');
    });

    it('removes inline event handlers from permitted elements', () => {
      const out = sanitizeHtml('<img src="x" onerror="window.__pwned = true" alt="a">');
      expect(out).not.toContain('onerror');
      expect(out).toContain('alt="a"');
    });

    it('rejects javascript: URLs in href and src', () => {
      expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
      expect(sanitizeHtml('<img src="javascript:alert(1)">')).not.toContain('javascript:');
    });

    it('rejects javascript: URLs obfuscated with entities and control characters', () => {
      expect(sanitizeHtml('<a href="java\tscript:alert(1)">x</a>')).not.toContain('alert(1)');
      expect(sanitizeHtml('<a href="&#106;avascript:alert(1)">x</a>')).not.toContain(
        'href="&#106;avascript'
      );
    });

    it('rejects data: and vbscript: URLs', () => {
      expect(sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>')).not.toContain(
        'data:text/html'
      );
      expect(sanitizeHtml('<a href="vbscript:msgbox(1)">x</a>')).not.toContain('vbscript:');
    });

    it('permits http, https and mailto URLs', () => {
      expect(sanitizeHtml('<a href="https://example.com">x</a>')).toContain(
        'href="https://example.com"'
      );
      expect(sanitizeHtml('<a href="mailto:a@b.c">x</a>')).toContain('href="mailto:a@b.c"');
    });

    it('forces rel=noopener noreferrer on links that open a new tab', () => {
      const out = sanitizeHtml('<a href="https://example.com" target="_blank">x</a>');
      expect(out).toContain('rel="noopener noreferrer"');
    });

    it('drops script-capable containers: iframe, object, embed, form, svg, style', () => {
      const out = sanitizeHtml(
        '<iframe src="https://evil.test"></iframe>' +
          '<object data="x"></object>' +
          '<embed src="x">' +
          '<form action="https://evil.test"><input name="a"></form>' +
          '<svg><script>alert(1)</script></svg>' +
          '<style>body{display:none}</style>'
      );
      expect(out).toBe('');
    });

    it('strips style attributes and data-* attributes', () => {
      const out = sanitizeHtml('<p style="position:fixed" data-x="1">t</p>');
      expect(out).toBe('<p>t</p>');
    });

    it('preserves the rich-text formatting the toolbar can produce', () => {
      const input =
        '<h1>T</h1><h2>S</h2><p><b>bold</b><i>it</i><u>un</u><s>st</s></p>' +
        '<ul><li>a</li></ul><ol><li>b</li></ol><blockquote>q</blockquote>' +
        '<pre>code</pre><a href="https://example.com">l</a>';
      const out = sanitizeHtml(input);
      for (const tag of ['h1', 'h2', 'b', 'i', 'u', 's', 'ul', 'ol', 'li', 'blockquote', 'pre', 'a']) {
        expect(out).toContain(`<${tag}`);
      }
    });

    it('returns an empty string for nullish and empty input', () => {
      expect(sanitizeHtml(null)).toBe('');
      expect(sanitizeHtml(undefined)).toBe('');
      expect(sanitizeHtml('')).toBe('');
    });

    it('throws TypeError rather than coercing a non-string argument', () => {
      expect(() => sanitizeHtml(42 as unknown as string)).toThrow(TypeError);
    });
  });

  describe('renderInlineMarkdown', () => {
    it('escapes markup so an injected tag is displayed, not executed', () => {
      const out = renderInlineMarkdown('<img src=x onerror=alert(1)>');
      expect(out).toBe('&lt;img src=x onerror=alert(1)&gt;');
      expect(out).not.toContain('<img');
    });

    it('neutralises a script payload arriving in a streamed LLM response', () => {
      const out = renderInlineMarkdown('<script>fetch("https://evil.test")</script>');
      expect(out).not.toContain('<script');
    });

    it('renders bold, italic, bold-italic and inline code', () => {
      expect(renderInlineMarkdown('**b**')).toBe('<strong>b</strong>');
      expect(renderInlineMarkdown('*i*')).toBe('<em>i</em>');
      expect(renderInlineMarkdown('***bi***')).toBe('<strong><em>bi</em></strong>');
      expect(renderInlineMarkdown('`c`')).toContain('<code');
      expect(renderInlineMarkdown('`c`')).toContain('>c</code>');
    });

    it('converts newlines to <br/>', () => {
      expect(renderInlineMarkdown('a\nb')).toBe('a<br/>b');
      expect(renderInlineMarkdown('a\r\nb')).toBe('a<br/>b');
    });

    it('does not treat lone asterisks inside words as emphasis', () => {
      expect(renderInlineMarkdown('2 * 3 * 4')).toBe('2 * 3 * 4');
    });

    it('returns an empty string for empty input', () => {
      expect(renderInlineMarkdown('')).toBe('');
      expect(renderInlineMarkdown(null)).toBe('');
    });
  });

  describe('plainTextToHtml', () => {
    it('escapes HTML in plain text instead of interpreting it', () => {
      expect(plainTextToHtml('<b>x</b>')).toBe('<p>&lt;b&gt;x&lt;/b&gt;</p>');
    });

    it('splits on blank lines and converts single newlines to <br>', () => {
      expect(plainTextToHtml('a\nb\n\nc')).toBe('<p>a<br>b</p><p>c</p>');
    });

    it('returns an empty string for empty input', () => {
      expect(plainTextToHtml('')).toBe('');
      expect(plainTextToHtml(null)).toBe('');
    });
  });

  describe('isSafeUrl', () => {
    it.each(['https://example.com', 'http://example.com', 'mailto:a@b.c', 'tel:+123'])(
      'accepts %s',
      (url) => {
        expect(isSafeUrl(url)).toBe(true);
      }
    );

    it.each(['/relative', '#anchor', '?query=1', 'path/to/page'])('accepts relative %s', (url) => {
      expect(isSafeUrl(url)).toBe(true);
    });

    it.each([
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ])('rejects %s', (url) => {
      expect(isSafeUrl(url)).toBe(false);
    });

    it('rejects control-character and whitespace obfuscation', () => {
      expect(isSafeUrl('java\u0000script:alert(1)')).toBe(false);
      expect(isSafeUrl('  javascript:alert(1)  ')).toBe(false);
      expect(isSafeUrl('java\tscript:alert(1)')).toBe(false);
    });

    it('rejects empty, whitespace-only and non-string input', () => {
      expect(isSafeUrl('')).toBe(false);
      expect(isSafeUrl('   ')).toBe(false);
      expect(isSafeUrl(null as unknown as string)).toBe(false);
    });
  });

  describe('regression: the sinks that used to be raw', () => {
    it('textToHtml escapes rather than interpolating raw markup', () => {
      expect(textToHtml('<img src=x onerror=alert(1)>')).toBe(
        '<p>&lt;img src=x onerror=alert(1)&gt;</p>'
      );
    });

    it('stripHtml returns text without executing scripts', () => {
      const out = stripHtml('<p>hi</p><script>window.__pwned = true</script>');
      expect(out).toBe('hi');
      expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    });

    it('stripHtml does not leak script or style source into plain text', () => {
      expect(stripHtml('<p>a</p><script>alert(1)</script>')).toBe('a');
      expect(stripHtml('<p>a</p><style>body{color:red}</style>')).toBe('a');
    });

    it('stripHtml does not fire image error handlers', () => {
      const out = stripHtml('<img src="http://127.0.0.1:1/x" onerror="window.__pwned = true">');
      expect(out).toBe('');
      expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    });
  });
});
