/**
 * Model cache for dynamic model selection.
 * Caches the list of available models from the SDK to avoid repeated queries.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * Model info from SDK.
 */
export interface ModelInfo {
  value: string;       // e.g., "claude-sonnet-4-5-20250929"
  displayName: string; // e.g., "Claude Sonnet 4.5"
  description: string; // Human-readable description
}

// Cached model list
let cachedModels: ModelInfo[] = [];
let lastRefresh: number = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Get available models from SDK (cached).
 * Returns cached list if fresh, otherwise refreshes from SDK.
 */
export async function getAvailableModels(): Promise<ModelInfo[]> {
  const now = Date.now();

  // Return cached if fresh
  if (cachedModels.length > 0 && (now - lastRefresh) < CACHE_TTL_MS) {
    return cachedModels;
  }

  // Refresh from SDK
  await refreshModelCache();
  return cachedModels;
}

/**
 * Force refresh the model cache from SDK.
 * Called on bot startup and can be called manually.
 */
export async function refreshModelCache(): Promise<ModelInfo[]> {
  try {
    // Start a minimal query just to get supportedModels()
    // We need to pass a prompt but will abort immediately after getting models
    const q = query({
      prompt: '',
      options: {
        maxTurns: 1,
      },
    });

    // Get supported models
    cachedModels = await q.supportedModels();
    lastRefresh = Date.now();
    console.log(`Model cache refreshed: ${cachedModels.map(m => m.displayName).join(', ')}`);

    // Abort the query since we only needed models
    try {
      await q.interrupt();
    } catch {
      // Ignore interrupt errors - query may have already ended
    }
  } catch (error) {
    console.error('Failed to refresh model cache:', error);
    // Keep existing cache if refresh fails
    if (cachedModels.length === 0) {
      // Fallback to known models if cache is empty
      cachedModels = [
        { value: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5', description: 'Best balance of speed and capability' },
        { value: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', description: 'Fastest model' },
        { value: 'claude-opus-4-5-20251101', displayName: 'Claude Opus 4.5', description: 'Most capable model' },
      ];
      console.log('Using fallback model list');
    }
  }
  return cachedModels;
}

/**
 * Check if a model ID is currently available.
 */
export async function isModelAvailable(modelId: string): Promise<boolean> {
  const models = await getAvailableModels();
  return models.some(m => m.value === modelId);
}

/**
 * Get model info by ID, or undefined if not found.
 */
export async function getModelInfo(modelId: string): Promise<ModelInfo | undefined> {
  const models = await getAvailableModels();
  return models.find(m => m.value === modelId);
}

/**
 * Get the default model (first in list, usually the recommended one).
 */
export async function getDefaultModel(): Promise<ModelInfo | undefined> {
  const models = await getAvailableModels();
  return models[0];
}
