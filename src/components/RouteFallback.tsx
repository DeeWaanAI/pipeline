/**
 * RouteFallback
 * Minimal full-viewport loading fallback shown by <Suspense> while a lazy
 * route chunk is loading. Uses the app's primary-colored spinner.
 */
export default function RouteFallback() {
  return (
    <div
      className="flex h-screen items-center justify-center"
      role="status"
      aria-label="Loading page"
    >
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
    </div>
  );
}
