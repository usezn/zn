// Type definitions for zn-gate/lib/rules (rule engine). Hand-written; keep in step with lib/rules.js.

/** Version string of the bundled rule set, for example "2026-10-19.3". */
export const RULES_VERSION: string;

/** Options accepted by the rule engine. */
export interface EvaluateOptions {
  /** Treat advisory rules as blocking. Also enabled by ZN_STRICT=1 or `strict` in a repository config. */
  strict?: boolean;
}

/** A rule that matched but did not block (advisory mode). */
export interface Advisory {
  rule: string;
  reason: string;
}

/** Result of one rule evaluation. */
export interface Assessment {
  verdict: 'allow' | 'block';
  /** 0 to 1. */
  confidence: number;
  /** Id of the matching rule, or "none" when the verdict is allow. */
  rule: string;
  /** Human-readable explanation; null when nothing matched. */
  reason: string | null;
  /** "oss-local" for results of the local engine. */
  engine: string;
  rules_version?: string;
  /** Set (to true) when the text was too large to scan in full. */
  truncated?: boolean;
  /** Present on an allow verdict when a rule matched in advisory mode. */
  advisory?: Advisory | null;
}

/** One secret that redactSecrets() replaced. */
export interface SecretDetection {
  rule: string;
  /** Character offset of the secret in the input. */
  index: number;
}

export interface RedactResult {
  sanitized: string;
  detections: SecretDetection[];
}

export interface SanitizeToolResultOptions extends EvaluateOptions {
  /** Output too large to scan in full is blocked by default (rule "size:truncated"); true here forces that block even with ZN_ALLOW_TRUNCATED=1. Also ZN_BLOCK_TRUNCATED=1. */
  blockTruncated?: boolean;
  /** Allow output too large to scan in full (it is marked truncated). Also ZN_ALLOW_TRUNCATED=1. */
  allowTruncated?: boolean;
  /** Redact credentials from the returned content (default true). */
  maskSecrets?: boolean;
}

export interface ToolResultReport {
  tool_name: string;
  safe_to_ingest: boolean;
  /** True when the output was not scanned in full. */
  truncated: boolean;
  assessment: Assessment;
  secrets_redacted: number;
  sanitized_content: string;
}

/** Deterministic, in-memory evaluation of a text. Never touches the network. */
export function evaluate(input: string, options?: EvaluateOptions): Assessment;

/** Replaces credentials in a text with placeholders. */
export function redactSecrets(text: string): RedactResult;

/** Scans a tool output for indirect prompt injection and redacts secrets. */
export function sanitizeToolResult(toolName: string, content: unknown, options?: SanitizeToolResultOptions): ToolResultReport;
/** Deep-redacts secrets in any string, array or object (no injection scan). */
export function sanitizeToolResult(value: unknown): { sanitized: unknown; detections: SecretDetection[] };
