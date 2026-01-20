/**
 * Tracks aborted fast-forward syncs.
 * When "Stop FF" button is clicked, we add to this set.
 * The sync loop checks this set between messages.
 */

const abortedFfSyncs = new Set<string>();

export function markFfAborted(conversationKey: string): void {
  abortedFfSyncs.add(conversationKey);
}

export function isFfAborted(conversationKey: string): boolean {
  return abortedFfSyncs.has(conversationKey);
}

export function clearFfAborted(conversationKey: string): void {
  abortedFfSyncs.delete(conversationKey);
}

// For testing only
export function resetFfAborted(): void {
  abortedFfSyncs.clear();
}
