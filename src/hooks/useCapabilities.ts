import { trpc } from "@/providers/trpc";
import { useCallback, useMemo } from "react";

/**
 * useCapabilities — the UI-side entitlements brain.
 *
 * Feature gates MUST use `has("<capability>")` (e.g. "pipeline:custom",
 * "pipeline:autodesign", "marketplace:publish") instead of comparing
 * `user.tier` directly. `tier` is returned for display/label purposes
 * only — never for authorization.
 */
export function useCapabilities() {
  const { data, isLoading } = trpc.billing.myCapabilities.useQuery(undefined, {
    staleTime: 1000 * 60 * 5,
    retry: false,
  });

  const capabilities = useMemo(() => data?.capabilities ?? [], [data]);
  const tier = data?.tier ?? "standard";

  const has = useCallback(
    (cap: string) => capabilities.includes(cap),
    [capabilities],
  );

  return useMemo(
    () => ({ has, capabilities, tier, isLoading }),
    [has, capabilities, tier, isLoading],
  );
}
