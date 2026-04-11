import DOMPurify from 'dompurify';
import CryptoJS from 'crypto-js';

// Encryption key (in production, this should be derived from user password)
const ENCRYPTION_KEY = import.meta.env.VITE_ENCRYPTION_KEY || 'noteflow-default-key-change-in-production';

// ============================================================================
// Security Constants
// ============================================================================

export const MAX_TITLE_LENGTH = 200;
export const MAX_CONTENT_LENGTH = 100000; // 100KB limit
export const MAX_TAG_LENGTH = 50;
export const MAX_TAGS_PER_NOTE = 20;

/**
 * Generate a secure unique ID using UUID v4
 */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Sanitize HTML content using DOMPurify
 */
export function sanitizeHtml(html: string): string {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'strong', 'em', 'u', 's', 'strike', 
                   'blockquote', 'code', 'pre', 'ul', 'ol', 'li', 'a', 'hr', 'div', 'span'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'style'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select'],
    FORBID_ATTR: ['onclick', 'onerror', 'onload', 'onmouseover', 'onfocus', 'onblur'],
  });
}

/**
 * Validate and sanitize note input
 */
export function validateNoteInput(title: string, content: string, tags: string[]): {
  isValid: boolean;
  errors: string[];
  sanitizedTitle: string;
  sanitizedContent: string;
  sanitizedTags: string[];
} {
  const errors: string[] = [];
  
  // Validate title
  const sanitizedTitle = title.slice(0, MAX_TITLE_LENGTH).trim();
  if (title.length > MAX_TITLE_LENGTH) {
    errors.push(`Title exceeds maximum length of ${MAX_TITLE_LENGTH} characters`);
  }
  
  // Validate content
  const sanitizedContent = sanitizeHtml(content.slice(0, MAX_CONTENT_LENGTH));
  if (content.length > MAX_CONTENT_LENGTH) {
    errors.push(`Content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`);
  }
  
  // Validate tags
  const sanitizedTags = tags
    .slice(0, MAX_TAGS_PER_NOTE)
    .map(tag => tag.slice(0, MAX_TAG_LENGTH).trim())
    .filter(tag => tag.length > 0);
  
  if (tags.length > MAX_TAGS_PER_NOTE) {
    errors.push(`Too many tags (maximum ${MAX_TAGS_PER_NOTE})`);
  }
  
  if (tags.some(tag => tag.length > MAX_TAG_LENGTH)) {
    errors.push(`Some tags exceed maximum length of ${MAX_TAG_LENGTH} characters`);
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    sanitizedTitle,
    sanitizedContent,
    sanitizedTags,
  };
}

/**
 * Sanitize AI prompt input to prevent prompt injection
 */
export function sanitizePromptInput(input: string): string {
  if (!input) return '';
  
  // Remove potential prompt injection patterns
  const sanitized = input
    .replace(/ignore\s+(previous|all)\s+instructions/gi, '')
    .replace(/you\s+are\s+now/gi, '')
    .replace(/system\s*:/gi, '')
    .replace(/<\|.*?\|>/g, '')
    .slice(0, 5000); // Limit prompt length
  
  return sanitized.trim();
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
 * Strip HTML tags and return plain text
 */
export function stripHtml(html: string): string {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
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
 * Convert plain text to HTML paragraphs
 */
export function textToHtml(text: string): string {
  return text
    .split('\n\n')
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
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
 * Encrypt data using AES encryption
 */
export function encryptData(data: unknown, customKey?: string): string {
  try {
    const key = customKey || ENCRYPTION_KEY;
    const jsonString = JSON.stringify(data);
    return CryptoJS.AES.encrypt(jsonString, key).toString();
  } catch (e) {
    console.error('Encryption failed:', e);
    return '';
  }
}

/**
 * Decrypt data using AES encryption
 */
export function decryptData<T>(encryptedData: string, customKey?: string): T | null {
  try {
    const key = customKey || ENCRYPTION_KEY;
    const bytes = CryptoJS.AES.decrypt(encryptedData, key);
    const decryptedString = bytes.toString(CryptoJS.enc.Utf8);
    return JSON.parse(decryptedString) as T;
  } catch (e) {
    console.error('Decryption failed:', e);
    return null;
  }
}

/**
 * Safe localStorage get with optional decryption
 */
export function safeLocalStorageGet<T>(key: string, fallback: T, encrypted: boolean = false): T {
  try {
    const item = localStorage.getItem(key);
    if (!item) return fallback;
    
    if (encrypted) {
      const decrypted = decryptData<T>(item);
      return decrypted !== null ? decrypted : fallback;
    }
    
    return item ? JSON.parse(item) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Safe localStorage set with optional encryption
 */
export function safeLocalStorageSet(key: string, value: unknown, encrypted: boolean = false): void {
  try {
    const dataToStore = encrypted ? encryptData(value) : JSON.stringify(value);
    if (dataToStore) {
      localStorage.setItem(key, dataToStore);
    }
  } catch (e) {
    console.error('Failed to save to localStorage:', e);
  }
}

/**
 * Clear all app data from localStorage
 */
export function clearAppData(): void {
  try {
    localStorage.removeItem('noteflow-data');
    localStorage.removeItem('noteflow-ai-memory');
  } catch (e) {
    console.error('Failed to clear localStorage:', e);
  }
}
