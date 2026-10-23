// Type definitions for zn-gate/lib/guard (tool-call guard). Hand-written; keep in step with lib/guard.js.
// Everything here runs locally. Nothing touches the network.

/** Result of one rule evaluation. */
export interface RuleAssessment {
  verdict: 'allow' | 'block';
  /** 0 to 1. */
  confidence: number;
  /** Id of the matching rule, or "none" when nothing matched. */
  rule: string;
  /** Human-readable explanation; null when nothing matched. */
  reason: string | null;
  /** "oss-local" for results of the local engine. */
  engine?: string;
  rules_version?: string;
  /** Set when the text was too large to scan in full. */
  truncated?: boolean;
  /** Present on an allow verdict when a rule matched in advisory mode. */
  advisory?: { rule: string; reason: string } | null;
}

/** Result of checkToolCall() and of the guarded call's check. */
export interface ToolCallAssessment extends RuleAssessment {
  /** False when the call (or the result) must not run or enter the model context. */
  allowed: boolean;
}

/** Options shared by checkToolCall() and guardTool(). */
export interface GuardEngineOptions {
  /** Treat advisory rules as blocking. Also enabled by ZN_STRICT=1. */
  strict?: boolean;
}

/** What guardTool() does when a call or result is blocked. */
export type GuardOnBlock = 'throw' | 'return';

export interface GuardToolOptions<Fallback = never> extends GuardEngineOptions {
  /** Tool name used in messages. Default: the function's name (an empty string for an anonymous function; messages then say "anonymous"). */
  name?: string;
  /** 'throw' (default) raises GuardBlockError; 'return' returns `fallback`, or the assessment when no fallback is given. */
  onBlock?: GuardOnBlock;
  /** Value returned when onBlock is 'return'. */
  fallback?: Fallback;
  /** Check the call arguments before the function runs. Default true. */
  checkArgs?: boolean;
  /** Check the return value before it is returned. Default false. */
  checkResult?: boolean;
  /** Redact credentials in the returned value. Default false. */
  maskSecrets?: boolean;
  /** With checkResult, block a result too large to scan in full. */
  blockTruncated?: boolean;
  /** With checkResult, allow a result too large to scan in full (blocked by default). Also ZN_ALLOW_TRUNCATED=1. */
  allowTruncated?: boolean;
  /** Called as (assessment, toolName, payload) before the block is applied. */
  onBlockCallback?: (assessment: ToolCallAssessment, name: string, payload: unknown) => void;
}

/** Thrown by a guarded tool when a call or its result is blocked (onBlock: 'throw'). */
export class GuardBlockError extends Error {
  readonly name: 'GuardBlockError';
  readonly code: 'ZN_GUARD_BLOCK';
  /** The assessment that caused the block. */
  readonly assessment: ToolCallAssessment;
  /** The tool name, or "<name>:result" for a blocked return value. */
  readonly target: string;
  /** The checked payload: { args } for a call, the result for a return value. */
  readonly payload: unknown;
  constructor(assessment: ToolCallAssessment, target?: string, payload?: unknown);
}

/**
 * Decides whether an agent tool call is safe to run. Every string in `args`
 * (nested values and object keys included) is evaluated; the first block wins.
 */
export function checkToolCall(toolName: string, args: unknown, opts?: GuardEngineOptions): ToolCallAssessment;

/** Value returned by a guarded function when the call is blocked with onBlock: 'return'. */
export type GuardBlockedValue<Fallback> = Fallback | ToolCallAssessment;

/**
 * Wraps a function so its arguments are checked before it runs and, with
 * checkResult, its return value before it is returned. Throws TypeError on an
 * unknown onBlock or a wrongly typed option.
 */
export function guardTool<F extends (...args: any[]) => any, Fallback = never>(
  fn: F,
  options?: GuardToolOptions<Fallback>,
): (...args: Parameters<F>) => ReturnType<F> extends Promise<infer U>
  ? Promise<Awaited<U> | GuardBlockedValue<Fallback>>
  : ReturnType<F> | GuardBlockedValue<Fallback>;
