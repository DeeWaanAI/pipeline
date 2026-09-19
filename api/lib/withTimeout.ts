/**
 * Race a promise against a hard deadline.
 *
 * Bounds calls that can hang forever without rejecting (e.g. an LLM HTTP
 * request whose stream stalls — fetch has no default timeout). The loser is
 * left running in the background and its result discarded; the timer is
 * always cleared so it never holds the event loop open.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
