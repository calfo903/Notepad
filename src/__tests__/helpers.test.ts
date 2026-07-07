import { describe, it, expect } from 'vitest';
import {
  generateId,
  stripHtml,
  countWords,
  countChars,
  estimateReadTime,
  formatRelativeDate,
  sanitizeFilename,
  truncateContent,
  cn,
  debounce,
  throttle,
} from '../utils/helpers';

describe('helpers', () => {
  describe('generateId', () => {
    it('should generate a unique ID', () => {
      const id1 = generateId();
      const id2 = generateId();
      expect(id1).not.toBe(id2);
      expect(typeof id1).toBe('string');
      expect(id1.length).toBeGreaterThan(10);
    });
  });

  describe('stripHtml', () => {
    it('should return empty string for empty input', () => {
      expect(stripHtml('')).toBe('');
    });

    it('should return empty string for null input', () => {
      expect(stripHtml(null as unknown as string)).toBe('');
    });

    it('should remove HTML tags from string', () => {
      expect(stripHtml('<p>Hello</p>')).toBe('Hello');
      expect(stripHtml('<div><span>Test</span></div>')).toBe('Test');
      expect(stripHtml('<b>Bold</b> and <i>italic</i>')).toBe('Bold and italic');
    });

    it('should handle nested tags', () => {
      expect(stripHtml('<div><p><span>Nested</span></p></div>')).toBe('Nested');
    });

    it('should handle self-closing tags', () => {
      expect(stripHtml('Line1<br/>Line2')).toBe('Line1Line2');
      expect(stripHtml('Image<img src="test.jpg"/>here')).toBe('Imagehere');
    });
  });

  describe('countWords', () => {
    it('should return 0 for empty string', () => {
      expect(countWords('')).toBe(0);
    });

    it('should count words correctly', () => {
      expect(countWords('Hello world')).toBe(2);
      expect(countWords('One two three')).toBe(3);
    });

    it('should handle multiple spaces', () => {
      expect(countWords('Hello   world')).toBe(2);
      expect(countWords('  Leading and trailing  ')).toBe(3);
    });

    it('should handle punctuation', () => {
      expect(countWords('Hello, world!')).toBe(2);
    });
  });

  describe('countChars', () => {
    it('should return 0 for empty string', () => {
      expect(countChars('')).toBe(0);
    });

    it('should count characters correctly', () => {
      expect(countChars('Hello')).toBe(5);
      expect(countChars('Hello world')).toBe(11);
    });

    it('should count spaces', () => {
      expect(countChars('Hello world')).toBe(11);
    });
  });

  describe('estimateReadTime', () => {
    it('should return "< 1 min" for 0 words', () => {
      expect(estimateReadTime(0)).toBe('< 1 min');
    });

    it('should return "< 1 min" for less than 200 words', () => {
      expect(estimateReadTime(100)).toBe('< 1 min');
      expect(estimateReadTime(199)).toBe('< 1 min');
    });

    it('should return "< 1 min" for exactly 200 words (ceil behavior)', () => {
      expect(estimateReadTime(200)).toBe('< 1 min');
    });

    it('should return correct minutes for more words', () => {
      // Math.ceil(201/200) = Math.ceil(1.005) = 2
      expect(estimateReadTime(201)).toBe('2 min');
      expect(estimateReadTime(400)).toBe('2 min');
      expect(estimateReadTime(401)).toBe('3 min');
    });
  });

  describe('formatRelativeDate', () => {
    it('should return "Just now" for very recent dates', () => {
      const now = Date.now();
      expect(formatRelativeDate(now)).toBe('Just now');
    });

    it('should return minutes ago', () => {
      const twoMinutesAgo = Date.now() - 2 * 60 * 1000;
      expect(formatRelativeDate(twoMinutesAgo)).toBe('2m ago');
    });

    it('should return hours ago', () => {
      const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
      expect(formatRelativeDate(threeHoursAgo)).toBe('3h ago');
    });

    it('should return days ago', () => {
      const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
      expect(formatRelativeDate(fiveDaysAgo)).toBe('5d ago');
    });
  });

  describe('sanitizeFilename', () => {
    it('should return empty string for empty input', () => {
      expect(sanitizeFilename('')).toBe('');
    });

    it('should remove invalid filename characters', () => {
      expect(sanitizeFilename('test<>:"/\\|?*')).toBe('test');
    });

    it('should replace spaces with underscores', () => {
      expect(sanitizeFilename('my note title')).toBe('my_note_title');
    });

    it('should limit length to 100 characters', () => {
      const longName = 'a'.repeat(150);
      expect(sanitizeFilename(longName).length).toBeLessThanOrEqual(100);
    });

    it('should preserve valid characters', () => {
      expect(sanitizeFilename('my-file_name.txt')).toBe('my-file_name.txt');
    });
  });

  describe('truncateContent', () => {
    it('should return full content if shorter than maxLength', () => {
      expect(truncateContent('<p>Short</p>', 100)).toBe('Short');
    });

    it('should truncate long content', () => {
      const longContent = '<p>' + 'a'.repeat(200) + '</p>';
      const result = truncateContent(longContent, 50);
      expect(result.length).toBeLessThanOrEqual(53); // 50 + '...'
      expect(result.endsWith('...')).toBe(true);
    });

    it('should use default maxLength of 120', () => {
      const longContent = '<p>' + 'a'.repeat(200) + '</p>';
      const result = truncateContent(longContent);
      expect(result.length).toBeLessThanOrEqual(123);
    });
  });

  describe('cn', () => {
    it('should join class names', () => {
      expect(cn('a', 'b', 'c')).toBe('a b c');
    });

    it('should filter out falsy values', () => {
      expect(cn('a', false, 'b', null, 'c', undefined)).toBe('a b c');
    });

    it('should handle empty inputs', () => {
      expect(cn()).toBe('');
    });
  });

  describe('debounce', () => {
    it('should debounce function calls', async () => {
      let callCount = 0;
      const fn = () => { callCount++; };
      const debouncedFn = debounce(fn, 100);

      debouncedFn();
      debouncedFn();
      debouncedFn();

      expect(callCount).toBe(0);

      await new Promise(resolve => setTimeout(resolve, 150));
      expect(callCount).toBe(1);
    });
  });

  describe('throttle', () => {
    it('should throttle function calls', async () => {
      let callCount = 0;
      const fn = () => { callCount++; };
      const throttledFn = throttle(fn, 100);

      throttledFn();
      throttledFn();
      throttledFn();

      expect(callCount).toBe(1);

      await new Promise(resolve => setTimeout(resolve, 150));
      throttledFn();
      expect(callCount).toBe(2);
    });
  });
});

