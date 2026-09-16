import { AIProvider, ProviderId, ProviderUnavailableError } from './types';
import { OpenRouterProvider } from './openRouterProvider';
import { PuterProvider } from './puterProvider';

/**
 * Provider registry.
 *
 * Resolution order:
 *   1. explicit `id` argument
 *   2. `VITE_AI_PROVIDER` build-time env
 *   3. `openrouter` default
 *
 * Instances are memoised: providers hold no per-request state, and a stable
 * reference keeps `useCallback` dependencies in `useAI` from invalidating.
 */

export const DEFAULT_PROVIDER: ProviderId = 'openrouter';

const instances = new Map<ProviderId, AIProvider>();

function create(id: ProviderId): AIProvider {
  switch (id) {
    case 'openrouter':
      return new OpenRouterProvider(import.meta.env.VITE_AI_MODEL);
    case 'puter':
      return new PuterProvider();
    default: {
      const exhaustive: never = id;
      throw new ProviderUnavailableError(`Unknown AI provider: ${String(exhaustive)}`, DEFAULT_PROVIDER);
    }
  }
}

function configuredId(): ProviderId {
  const configured = import.meta.env.VITE_AI_PROVIDER;
  return configured === 'puter' || configured === 'openrouter' ? configured : DEFAULT_PROVIDER;
}

export function getProvider(id?: ProviderId): AIProvider {
  const resolved = id ?? configuredId();

  const existing = instances.get(resolved);
  if (existing) return existing;

  const created = create(resolved);
  instances.set(resolved, created);
  return created;
}

/** Every registered provider, for a settings UI. */
export function listProviders(): readonly AIProvider[] {
  const ids: readonly ProviderId[] = ['openrouter', 'puter'];
  return ids.map((id) => getProvider(id));
}

/** Test hook: drop memoised instances so a fresh one is built on next access. */
export function resetProviderRegistry(): void {
  instances.clear();
}
