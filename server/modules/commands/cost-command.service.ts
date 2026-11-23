import { readOptionalTokenCount } from '@/shared/index.js';
import type { ClaudeResponseTokenUsage } from '@/shared/index.js';
import type { AnyRecord } from '@/shared/types.js';

type CostBreakdown = ClaudeResponseTokenUsage & { cacheHitRate?: number };

function readClaudeCostBreakdown(snapshot: unknown): CostBreakdown {
  if (!snapshot || typeof snapshot !== 'object') {
    return {};
  }

  const counters = snapshot as Record<string, unknown>;
  const input = readOptionalTokenCount(counters.input);
  const cacheRead = readOptionalTokenCount(counters.cacheRead);
  const cacheWrite = readOptionalTokenCount(counters.cacheWrite);
  const output = readOptionalTokenCount(counters.output);
  const uncachedInput = readOptionalTokenCount(counters.uncachedInput)
    ?? (input !== undefined && cacheRead !== undefined && cacheWrite !== undefined && input >= cacheRead + cacheWrite
      ? input - cacheRead - cacheWrite
      : undefined);
  const cacheHitRate = input !== undefined && input > 0 && cacheRead !== undefined && cacheRead <= input
    ? cacheRead / input
    : undefined;

  return { input, uncachedInput, cacheRead, cacheWrite, output, cacheHitRate };
}

/** Used by the commands router to turn the composer's token snapshot into `/cost` data. */
export function summarizeCostCommandUsage(provider: string, usage: unknown) {
  const tokenUsage = (usage && typeof usage === 'object' ? usage : {}) as AnyRecord;
  const total = Number(tokenUsage.total ?? tokenUsage.contextWindow ?? 0) || 0;

  if (provider === 'claude') {
    // Do not read the numeric composer meter: it may be a partial subtotal or
    // the SDK's cumulative bill, neither of which describes the latest response.
    const tokenBreakdown = readClaudeCostBreakdown(tokenUsage.latestResponse);
    const { input, output } = tokenBreakdown;
    const used = input !== undefined && output !== undefined ? input + output : undefined;
    return { tokenUsage: { used, total }, tokenBreakdown };
  }

  // Other providers retain their existing input/output and context semantics.
  const reportedUsed = Number(tokenUsage.used ?? tokenUsage.totalUsed ?? tokenUsage.total_tokens ?? 0) || 0;
  const normalizedInput = tokenUsage.inputTokens ?? tokenUsage.input ?? tokenUsage.cumulativeInputTokens
    ?? tokenUsage.breakdown?.input ?? tokenUsage.promptTokens;
  let input = Number(normalizedInput ?? tokenUsage.input_tokens ?? 0) || 0;
  if (normalizedInput == null) {
    input += (Number(tokenUsage.cacheReadTokens ?? tokenUsage.cache_read_input_tokens ?? tokenUsage.cacheReadInputTokens ?? 0) || 0)
      + (Number(tokenUsage.cacheCreationTokens ?? tokenUsage.cache_creation_input_tokens ?? tokenUsage.cacheCreationInputTokens ?? 0) || 0);
  }
  const output = Number(tokenUsage.outputTokens ?? tokenUsage.output ?? tokenUsage.output_tokens
    ?? tokenUsage.cumulativeOutputTokens ?? tokenUsage.breakdown?.output ?? tokenUsage.completionTokens ?? 0) || 0;
  const used = Math.max(reportedUsed, input + output);

  return {
    tokenUsage: { used, total },
    ...(input + output > 0 ? { tokenBreakdown: { input, output } } : {}),
  };
}
