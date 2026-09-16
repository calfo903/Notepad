import { memo, useEffect, useState } from 'react';
import type { AuthStore } from '../hooks/useAuth';
import type { SyncStore } from '../hooks/useSync';
import { cn } from '../utils/helpers';
import { Icons } from './icons';

interface AccountPanelProps {
  auth: AuthStore;
  sync?: SyncStore;
  compact?: boolean;
}

const SYNC_LABEL: Record<string, { text: string; className: string }> = {
  syncing: { text: 'Syncing…', className: 'bg-accent' },
  idle: { text: 'Synced', className: 'bg-success' },
  error: { text: 'Sync failed', className: 'bg-danger' },
  disabled: { text: 'Local only', className: 'bg-warning' },
};

/**
 * Sign-in / account chip for the sidebar footer.
 *
 * Uses Google's own rendered button for the button flow (their brand guidelines
 * require it) with an app-styled fallback that drives the same One Tap flow.
 */
export const AccountPanel = memo(function AccountPanel({
  auth,
  sync,
  compact = false,
}: AccountPanelProps) {
  const [buttonReady, setButtonReady] = useState(false);
  const { user, status, error, isSigningIn, isConfigured } = auth;

  // GIS injects an iframe into this node; mount it once the script is available.
  useEffect(() => {
    let cancelled = false;

    if (!isConfigured || status === 'authenticated') return;

    void auth
      .renderGoogleButton({ size: 'medium', theme: 'outline', shape: 'pill' })
      .then(() => {
        if (!cancelled) setButtonReady(true);
      })
      .catch(() => {
        // Script blocked or offline; the text fallback below still works.
        if (!cancelled) setButtonReady(false);
      });

    return () => {
      cancelled = true;
    };
  }, [auth, isConfigured, status]);

  if (!isConfigured) {
    return (
      <p className="text-xs text-text-secondary-dark/40">
        Set VITE_GOOGLE_CLIENT_ID to enable sign-in.
      </p>
    );
  }

  if (status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-xs text-text-secondary-dark/60">
        <span className="w-5 h-5 rounded-full bg-white/10 animate-pulse" />
        <span>Checking session…</span>
      </div>
    );
  }

  if (user) {
    return (
      <div className="flex items-center gap-2.5 min-w-0">
        {user.picture ? (
          <img
            src={user.picture}
            alt=""
            referrerPolicy="no-referrer"
            className="w-7 h-7 rounded-full flex-shrink-0 ring-1 ring-white/10"
          />
        ) : (
          <span className="w-7 h-7 rounded-full bg-accent/20 text-accent flex items-center justify-center text-xs font-semibold flex-shrink-0">
            {user.name.slice(0, 1).toUpperCase()}
          </span>
        )}

        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-white truncate">{user.name}</p>
          <p className="text-[11px] text-text-secondary-dark/60 truncate">{user.email}</p>
        </div>

        {sync && (
          <span
            title={sync.error ?? SYNC_LABEL[sync.status].text}
            className="flex items-center gap-1.5 text-[10px] text-text-secondary-dark/70 flex-shrink-0"
          >
            <span
              className={cn(
                'w-1.5 h-1.5 rounded-full',
                SYNC_LABEL[sync.status].className,
                sync.status === 'syncing' && 'animate-pulse'
              )}
            />
            {SYNC_LABEL[sync.status].text}
          </span>
        )}

        <button
          type="button"
          onClick={() => void auth.signOut()}
          title="Sign out"
          aria-label="Sign out"
          className="p-1.5 rounded-lg text-text-secondary-dark/60 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
        >
          <Icons.Close className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div ref={auth.setGoogleButtonRef} className={cn(!buttonReady && 'hidden')} />

      <button
        type="button"
        onClick={() => void auth.signIn()}
        disabled={isSigningIn}
        className={cn(
          'w-full flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-medium',
          'bg-white/5 hover:bg-white/10 text-text-secondary-dark hover:text-white',
          'border border-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
          compact && 'py-1.5'
        )}
      >
        <span className="w-3.5 h-3.5 rounded-full bg-gradient-to-br from-purple-400 to-blue-500 flex-shrink-0" />
        {isSigningIn ? 'Signing in…' : buttonReady ? 'Use another account' : 'Sign in with Google'}
      </button>

      {error && <p className="text-[11px] text-danger leading-snug">{error}</p>}
    </div>
  );
});
