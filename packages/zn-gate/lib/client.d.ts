// Type definitions for zn-gate (package entry: lib/client.js). Hand-written; keep in step with lib/client.js.

import type { Assessment, EvaluateOptions, ToolResultReport, SanitizeToolResultOptions } from './rules';

export type { Assessment, Advisory, EvaluateOptions, SanitizeToolResultOptions } from './rules';
export { evaluate, RULES_VERSION } from './rules';
export { sanitizeToolResult, redactSecrets } from './rules';
export type { SecretDetection, RedactResult } from './rules';
export { logEvidence, verifyEvidenceLedger } from './evidence';
export type { EvidenceEvent, EvidenceRecord, EvidenceVerification } from './evidence';
export { checkToolCall, guardTool, GuardBlockError } from './guard';
export type {
  RuleAssessment,
  ToolCallAssessment,
  GuardToolOptions,
  GuardEngineOptions,
  GuardOnBlock,
  GuardBlockedValue,
} from './guard';

export type LongInputMode = 'off' | 'windows';

/** Options for analyze(). */
export interface AnalyzeOptions extends EvaluateOptions {
  /** API key for cloud analysis. Used only together with ZN_CLOUD=1. Falls back to ZN_API_KEY. */
  apiKey?: string;
  /** Never use the cloud for this call (also ZN_LOCAL_ONLY=true). */
  localOnly?: boolean;
  /** Custom gateway URL. Ignored for a key saved by `zn-gate connect`. Falls back to ZN_API_URL. */
  apiUrl?: string;
  /** Gateway stage, "v30" (default) or "prod". Falls back to ZN_STAGE. */
  stage?: string;
  /** Request timeout in milliseconds. */
  timeout?: number;
  /** How long texts are sent to the cloud gate: "windows" (default) or "off". Falls back to ZN_LONG_INPUT. */
  longInput?: string;
}

export interface LongInputInfo {
  mode?: string;
  windows?: number;
  capped?: boolean;
  reason?: string;
  [key: string]: unknown;
}

/** Result of analyze() and analyzeLocal(): a rule assessment plus where it came from. */
export interface AnalyzeResult extends Assessment {
  mode: 'oss-local' | 'hybrid-local-fastpath' | 'hybrid-cloud';
  /** True when the cloud was enabled but local rules were used instead. */
  fallback?: boolean;
  /** Why the cloud result was not used (set with fallback). */
  cloud_error?: string;
  /** Number of secrets redacted from the text before it was sent to the cloud. */
  secrets_redacted_before_upload?: number;
  note?: string;
  warning?: string;
  long_input?: LongInputInfo;
  /** A cloud response can carry more fields. */
  [key: string]: unknown;
}

/** Assessment attached to a checkToolResult() report. */
export interface ToolResultAssessment extends Omit<Assessment, 'reason'> {
  /** Absent for empty or tiny output. */
  reason?: string | null;
  mode: 'oss-local' | 'hybrid-local-fastpath';
}

export interface CheckedToolResult extends Omit<ToolResultReport, 'assessment'> {
  assessment: ToolResultAssessment;
}

export interface ResolveEndpointOptions {
  apiUrl?: string;
  stage?: string;
}

/** Minimum text length (in characters) that asks the cloud gate for windowed scanning. */
export const LONG_INPUT_MIN_CHARS: number;

/**
 * Prompt analysis. Local rules first; the cloud is asked only when the user
 * opted in. Secrets are redacted locally before any upload.
 */
export function analyze(input: string, options?: AnalyzeOptions): Promise<AnalyzeResult>;

/** Local-only evaluation. Never touches the network. */
export function analyzeLocal(input: string, options?: EvaluateOptions): AnalyzeResult;

/**
 * Inspects tool output before it enters the model context. Local only; secrets
 * are always redacted from sanitized_content.
 */
export function checkToolResult(toolName: string, content: unknown, options?: SanitizeToolResultOptions): Promise<CheckedToolResult>;

/** "windows" (default) or "off", from options.longInput or ZN_LONG_INPUT. */
export function longInputMode(options?: Pick<AnalyzeOptions, 'longInput'>): LongInputMode;

export function isCloudEnabled(options?: AnalyzeOptions): boolean;
export function usesStoredKey(options?: AnalyzeOptions): boolean;
/** The key when it has the expected shape, otherwise null. */
export function usableApiKey(value: unknown): string | null;
export function resolveEndpoint(options?: ResolveEndpointOptions, flags?: { stored?: boolean }): string;
