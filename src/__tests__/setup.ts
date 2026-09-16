import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Setup for Vitest.
//
// This file runs for every test file, including the server suite which is
// pinned to the node environment (Edge code has no `window`). Every browser
// mock below is therefore guarded, or those tests cannot even load.

const isBrowser = typeof window !== 'undefined';

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

if (isBrowser) {
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
}
