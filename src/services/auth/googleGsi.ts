/**
 * Google Identity Services loader.
 *
 * The GIS script is injected on demand rather than via a <script> tag in
 * index.html, so an app built without a client id never pays for it and the
 * render path is not blocked on a third-party origin.
 */

const GSI_SRC = 'https://accounts.google.com/gsi/client';

export interface CredentialResponse {
  readonly credential: string;
  readonly select_by?: string;
}

export interface PromptMoment {
  isNotDisplayed(): boolean;
  isSkippedMoment(): boolean;
  isDismissedMoment(): boolean;
  getNotDisplayedReason(): string;
  getSkippedReason(): string;
  getDismissedReason(): string;
}

export interface IdConfiguration {
  client_id: string;
  callback: (response: CredentialResponse) => void;
  nonce?: string;
  ux_mode?: 'popup' | 'redirect';
  auto_select?: boolean;
  cancel_on_tap_outside?: boolean;
  itp_support?: boolean;
}

export interface RenderButtonOptions {
  theme?: 'outline' | 'filled_blue' | 'filled_black';
  size?: 'large' | 'medium' | 'small';
  text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
  shape?: 'rectangular' | 'pill' | 'circle' | 'square';
  width?: number;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(config: IdConfiguration): void;
          prompt(listener?: (moment: PromptMoment) => void): void;
          renderButton(parent: HTMLElement, options?: RenderButtonOptions): void;
          disableAutoSelect(): void;
        };
      };
    };
  }
}

export class GoogleAuthUnavailableError extends Error {
  override readonly name = 'GoogleAuthUnavailableError';

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, GoogleAuthUnavailableError.prototype);
  }
}

let loadPromise: Promise<void> | null = null;

/** Inject the GIS script exactly once, even under concurrent callers. */
export function loadGoogleIdentityServices(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new GoogleAuthUnavailableError('Google sign-in requires a browser.'));
  }

  if (window.google?.accounts?.id) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);

    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener(
        'error',
        () => reject(new GoogleAuthUnavailableError('Could not load Google sign-in script.')),
        { once: true }
      );
      return;
    }

    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    // The script must never be able to read or alter this page's DOM.
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'strict-origin-when-cross-origin';
    script.addEventListener('load', () => {
      if (window.google?.accounts?.id) resolve();
      else reject(new GoogleAuthUnavailableError('Google sign-in script loaded but exposed no API.'));
    });
    script.addEventListener(
      'error',
      () => {
        loadPromise = null;
        reject(new GoogleAuthUnavailableError('Could not load Google sign-in script.'));
      },
      { once: true }
    );

    document.head.appendChild(script);
  });

  return loadPromise;
}

export interface GoogleAccountsId {
  initialize(config: IdConfiguration): void;
  prompt(listener?: (moment: PromptMoment) => void): void;
  renderButton(parent: HTMLElement, options?: RenderButtonOptions): void;
  disableAutoSelect(): void;
}

export function googleAccountsId(): GoogleAccountsId {
  const id = window.google?.accounts?.id;
  if (!id) throw new GoogleAuthUnavailableError('Google sign-in is not ready.');
  return id;
}
