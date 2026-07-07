import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Setup for Vitest
// Add global mocks here if needed

// Mock localStorage for tests
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

// Mock puter for AI tests
Object.defineProperty(window, 'puter', {
  value: {
    ai: {
      chat: vi.fn(),
    },
  },
  writable: true,
});
