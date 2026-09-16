// ============================================================================
// HTML Sanitization Boundary
//
// Single choke point for every value that reaches an HTML sink in this app
// (`innerHTML`, `dangerouslySetInnerHTML`, exported `.html` files). Untrusted
// origins are: LLM responses, contentEditable serialisation, and anything
// hydrated from localStorage.
//
// Policy is fail-closed. A value we cannot sanitise is never returned raw.
// ============================================================================

import DOMPurify from 'dompurify';

/** Raised when the sanitizer is invoked outside a DOM environment. */
export class SanitizerUnavailableError extends Error {
  override readonly name = 'SanitizerUnavailableError';

  constructor() {
    super(
      'HTML sanitizer requires a DOM. Call it from the browser, or provide a ' +
        'jsdom window in tests. Refusing to return unsanitized markup.'
    );
  }
}

const HTML_ESCAPE_MAP: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

const HTML_ESCAPE_PATTERN = /[&<>"']/g;

/**
 * Escape a string so it is inert as HTML text content.
 * Pure, allocation-light, and safe to call on already-escaped input at the cost
 * of double-encoding — callers must escape exactly once, before interpolation.
 */
export function escapeHtml(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value.replace(HTML_ESCAPE_PATTERN, (char) => HTML_ESCAPE_MAP[char] ?? char);
}

/**
 * Allowlisted tag/attribute policy for user-authored rich text.
 * Deliberately excludes script, style, iframe, object, embed, form, svg and
 * math: all are script-capable or CSS-injection vectors in a note body.
 */
const RICH_TEXT_TAGS: readonly string[] = Object.freeze([
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'li',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
]);

const RICH_TEXT_ATTRS: readonly string[] = Object.freeze([
  'abbr',
  'align',
  'alt',
  'class',
  'colspan',
  'href',
  'lang',
  'rel',
  'rowspan',
  'scope',
  'src',
  'start',
  'target',
  'title',
  'width',
]);

/**
 * Schemes permitted in `href`/`src`. Blocks `javascript:`, `data:` and `vbscript:`
 * independently of DOMPurify's built-in heuristic so the policy stays explicit.
 * Anchors are matched against the lower-cased, control-character-stripped value.
 */
const SAFE_URI_PATTERN = /^(?:(?:https?|mailto|tel):|[^a-z]|[/#.?-])/i;

let configured = false;

function ensureConfigured(): typeof DOMPurify {
  if (configured) return DOMPurify;

  // Force external links to open without window.opener back-reference and to be
  // treated as untrusted by the browser's referrer policy.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof Element)) return;

    if (node.tagName === 'A' && node.hasAttribute('target')) {
      node.setAttribute('rel', 'noopener noreferrer');
    }

    // Belt-and-braces: drop any surviving inline event handler or style that
    // slipped past the attribute allowlist.
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'style' || name === 'formaction') {
        node.removeAttribute(attr.name);
      }
    }
  });

  configured = true;
  return DOMPurify;
}

/**
 * Sanitize untrusted HTML down to the rich-text allowlist.
 *
 * Fail-closed contract: returns `''` for nullish input, and throws
 * {@link SanitizerUnavailableError} if no DOM exists rather than passing the
 * value through.
 */
export function sanitizeHtml(dirty: string | null | undefined): string {
  if (dirty === null || dirty === undefined) return '';
  if (typeof dirty !== 'string') {
    throw new TypeError(
      `sanitizeHtml expects a string, received ${typeof dirty}`
    );
  }
  if (dirty.length === 0) return '';
  if (typeof window === 'undefined') throw new SanitizerUnavailableError();

  return ensureConfigured().sanitize(dirty, {
    ALLOWED_TAGS: [...RICH_TEXT_TAGS],
    ALLOWED_ATTR: [...RICH_TEXT_ATTRS],
    ALLOWED_URI_REGEXP: SAFE_URI_PATTERN,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    KEEP_CONTENT: true,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'svg', 'math'],
    FORBID_ATTR: ['style', 'srcdoc', 'formaction', 'xlink:href'],
    WHOLE_DOCUMENT: false,
    RETURN_DOM: false,
    RETURN_TRUSTED_TYPE: false,
  }) as string;
}

/**
 * Validate a user-supplied URL before it is handed to `execCommand('createLink')`.
 *
 * Required because execCommand writes the anchor into the live editor DOM
 * directly, bypassing the sanitization boundary — a `javascript:` href would be
 * clickable immediately. Rejects script-executing schemes and anything the URL
 * parser cannot make sense of.
 */
export function isSafeUrl(url: string): boolean {
  if (typeof url !== 'string') return false;

  // Strip control characters and surrounding whitespace; browsers ignore them
  // when resolving a URL, so checking the raw string alone is bypassable.
  const candidate = url.replace(/[\u0000-\u0020\u007f]/g, '').trim();
  if (candidate.length === 0) return false;

  // Relative and fragment-only references are always safe.
  if (/^[/.#?]/.test(candidate)) return true;

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(candidate);
  if (!schemeMatch) return true;

  const scheme = schemeMatch[1].toLowerCase();
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel';
}

/**
 * Render a restricted Markdown subset (bold, italic, inline code, line breaks)
 * to safe HTML. Escapes the source text first, so markup in the input is
 * displayed literally instead of executed — the ordering is the entire security
 * property of this function.
 */
export function renderInlineMarkdown(source: string | null | undefined): string {
  if (!source) return '';

  const escaped = escapeHtml(source);

  return escaped
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<![*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, '<em>$1</em>')
    .replace(/`(?=\S)([^`\n]*?\S)`/g, '<code class="bg-black/10 dark:bg-white/10 px-1 rounded text-sm">$1</code>')
    .replace(/\r?\n/g, '<br/>');
}

/**
 * Wrap plain text in block-level HTML without letting the text itself become
 * markup. Used when inserting LLM output or imported text into a note body.
 */
export function plainTextToHtml(text: string | null | undefined): string {
  if (!text) return '';

  return text
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\r?\n/g, '<br>')}</p>`)
    .join('');
}

/** Test/teardown helper — clears hooks so repeated imports do not stack them. */
export function resetSanitizerForTests(): void {
  if (typeof window === 'undefined') return;
  DOMPurify.removeAllHooks();
  configured = false;
}
