import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AuthRequestError,
  AuthUser,
  endSession,
  exchangeGoogleCredential,
  fetchSession,
  generateNonce,
  issueCsrfToken,
} from '../services/auth/authClient';
import {
  GoogleAuthUnavailableError,
  googleAccountsId,
  loadGoogleIdentityServices,
  RenderButtonOptions,
} from '../services/auth/googleGsi';

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

/**
 * Google sign-in state.
 *
 * The credential flow is: generate a nonce, hand it to GIS so Google stamps it
 * into the ID token, then send token + nonce to our endpoint. The server refuses
 * any token whose nonce does not match, which makes a captured token useless in
 * a different session.
 */
export function useAuth() {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  const isConfigured = typeof clientId === 'string' && clientId.length > 0;

  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);

  // Restore an existing session on mount. A 401 is the normal signed-out state.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const session = await fetchSession();
        if (cancelled) return;
        setUser(session);
        setStatus(session ? 'authenticated' : 'anonymous');
      } catch (err) {
        if (cancelled) return;
        setUser(null);
        setStatus('anonymous');
        if (err instanceof AuthRequestError && err.code !== 'AUTH_NOT_CONFIGURED') {
          setError(err.message);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Open One Tap. Resolves once the session cookie is set.
   *
   * Rejecting here does not break the button path: `initialize` has already
   * registered the callback with GIS, so a click on the rendered button still
   * completes sign-in.
   */
  const signIn = useCallback(async (): Promise<void> => {
    if (!isConfigured || !clientId) {
      setError('Google sign-in is not configured. Set VITE_GOOGLE_CLIENT_ID.');
      return;
    }

    setIsSigningIn(true);
    setError(null);

    try {
      await loadGoogleIdentityServices();
      const accounts = googleAccountsId();

      const nonce = generateNonce();
      const csrfToken = issueCsrfToken();

      await new Promise<void>((resolve, reject) => {
        accounts.initialize({
          client_id: clientId,
          nonce,
          ux_mode: 'popup',
          auto_select: false,
          cancel_on_tap_outside: true,
          callback: (response) => {
            void exchangeGoogleCredential(response.credential, nonce, csrfToken)
              .then((signedIn) => {
                setUser(signedIn);
                setStatus('authenticated');
                resolve();
              })
              .catch((err: unknown) => {
                reject(
                  err instanceof AuthRequestError || err instanceof Error
                    ? err
                    : new Error('Sign-in failed.')
                );
              });
          },
        });

        accounts.prompt((moment) => {
          if (moment.isNotDisplayed() || moment.isSkippedMoment()) {
            reject(
              new GoogleAuthUnavailableError(
                `Google suppressed the sign-in prompt (${moment.getNotDisplayedReason() || moment.getSkippedReason()}). Use the Google button instead.`
              )
            );
          }
        });
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Google sign-in could not be completed.'
      );
    } finally {
      setIsSigningIn(false);
    }
  }, [clientId, isConfigured]);

  const signOut = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      await endSession();
      // Stop GIS from silently re-selecting the account on the next prompt.
      if (window.google?.accounts?.id) window.google.accounts.id.disableAutoSelect();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-out failed.');
    } finally {
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  /**
   * Render Google's own branded button. Google requires their button for the
   * button flow, so this delegates to GIS rather than drawing a lookalike.
   */
  const renderGoogleButtonRef = useRef<HTMLElement | null>(null);
  const setGoogleButtonRef = useCallback(
    (node: HTMLElement | null) => {
      renderGoogleButtonRef.current = node;
    },
    []
  );

  const renderGoogleButton = useCallback(
    async (options?: RenderButtonOptions): Promise<void> => {
      if (!isConfigured || !clientId) return;
      const node = renderGoogleButtonRef.current;
      if (!node) return;

      await loadGoogleIdentityServices();
      googleAccountsId().renderButton(node, {
        theme: 'outline',
        size: 'medium',
        text: 'signin_with',
        shape: 'pill',
        ...options,
      });
    },
    [clientId, isConfigured]
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    user,
    status,
    error,
    isSigningIn,
    isConfigured,
    signIn,
    signOut,
    setGoogleButtonRef,
    renderGoogleButton,
    clearError,
  };
}

export type AuthStore = ReturnType<typeof useAuth>;
