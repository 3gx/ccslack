/**
 * Tracks aborted queries to prevent race conditions.
 * When abort is clicked, we add to this set BEFORE any async operations.
 * The main flow checks this set before updating status to "Done".
 */

const abortedQueries = new Set<string>();

export function markAborted(conversationKey: string): void {
  abortedQueries.add(conversationKey);
}

export function isAborted(conversationKey: string): boolean {
  return abortedQueries.has(conversationKey);
}

export function clearAborted(conversationKey: string): void {
  abortedQueries.delete(conversationKey);
}

// For testing only
export function reset(): void {
  abortedQueries.clear();
}
