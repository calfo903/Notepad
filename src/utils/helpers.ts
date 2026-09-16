// ============================================================================
// Utility Functions
// ============================================================================

import { plainTextToHtml } from './sanitize';

/**
 * Generate a unique ID
 */
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

/**
 * Debounce function for performance optimization
 */
export function debounce<T extends (...args: unknown[]) => unknown>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Throttle function for scroll/resize events
 */
export function throttle<T extends (...args: unknown[]) => unknown>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle: boolean;
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * Tags whose *text* is not content. In a parsed document their source is a
 * child text node, so `textContent` would leak `<script>` bodies into note
 * previews, word counts and `.txt` exports.
 */
const NON_CONTENT_SELECTOR = 'script, style, template, noscript, iframe, object, embed, svg, math';

function removeNonContentNodes(root: ParentNode): void {
  root.querySelectorAll(NON_CONTENT_SELECTOR).forEach((el) => el.remove());
}

/**
 * Strip HTML tags and return plain text.
 *
 * Uses DOMParser rather than `innerHTML` on a detached element: the parsed
 * document is inert, so `<script>` never runs and `<img src=… onerror=…>` never
 * fires, even when the markup came from an LLM or from localStorage.
 * SSR-safe: falls back to regex when no DOM is available.
 */
export function stripHtml(html: string): string {
  if (!html) return '';
  if (typeof window === 'undefined') {
    return html.replace(/<[^>]*>/g, '');
  }

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    removeNonContentNodes(doc);
    return doc.body?.textContent ?? '';
  } catch (e) {
    // DOMParser unavailable (legacy environment). Detached parse as fallback —
    // still no script execution because the node never connects to a document.
    console.warn('DOMParser unavailable, falling back to detached parse:', e);
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    removeNonContentNodes(tmp);
    return tmp.textContent || '';
  }
}

/**
 * Count words in text
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Count characters in text
 */
export function countChars(text: string): number {
  return text.length;
}

/**
 * Estimate reading time in minutes
 */
export function estimateReadTime(words: number): string {
  const minutes = Math.ceil(words / 200);
  return minutes <= 1 ? '< 1 min' : `${minutes} min`;
}

/**
 * Format relative date (e.g., "Just now", "5m ago", "2d ago")
 */
export function formatRelativeDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

/**
 * Format full date
 */
export function formatFullDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Truncate HTML content to plain text preview
 */
export function truncateContent(html: string, maxLength: number = 120): string {
  const text = stripHtml(html);
  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

/**
 * Convert plain text to HTML paragraphs.
 * The text is escaped, so HTML in the input renders literally instead of
 * executing. Delegates to the sanitization module to keep escaping in one place.
 */
export function textToHtml(text: string): string {
  return plainTextToHtml(text);
}

/**
 * Convert HTML to Markdown (basic)
 */
export function htmlToMarkdown(html: string): string {
  return html
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
    .replace(/<u[^>]*>(.*?)<\/u>/gi, '$1')
    .replace(/<s[^>]*>(.*?)<\/s>/gi, '~~$1~~')
    .replace(/<strike[^>]*>(.*?)<\/strike>/gi, '~~$1~~')
    .replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gi, '> $1\n\n')
    .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
    .replace(/<pre[^>]*>(.*?)<\/pre>/gis, '```\n$1\n```\n\n')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<ul[^>]*>|<\/ul>/gi, '\n')
    .replace(/<ol[^>]*>|<\/ol>/gi, '\n')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<hr[^>]*>/gi, '\n---\n\n')
    .replace(/<br[^>]*>/gi, '\n')
    .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Classnames utility (similar to clsx)
 */
export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

/**
 * Check if device is mobile
 */
export function isMobile(): boolean {
  return window.innerWidth < 768;
}

/**
 * Check if device supports touch
 */
export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

/**
 * Safe localStorage get
 */
export function safeLocalStorageGet<T>(key: string, fallback: T): T {
  try {
    const item = localStorage.getItem(key);
    return item ? JSON.parse(item) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Safe localStorage set
 */
export function safeLocalStorageSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error('Failed to save to localStorage:', e);
  }
}

/**
 * Sanitize a string for use as a filename
 * Removes characters that are invalid in filenames on most operating systems
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 100);
}
