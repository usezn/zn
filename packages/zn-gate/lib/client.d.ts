// Type definitions for zn-gate (package entry: lib/client.js). Hand-written; keep in step with lib/client.js.
// This file declares the tool-call guard and the four helpers it is used with. Other exports of
// lib/client.js are not declared here yet.

import type { RuleAssessment, ToolCallAssessment } from './guard';

export { checkToolCall, guardTool, GuardBlockError } from './guard';
export type {
  RuleAssessment,
  ToolCallAssessment,
  GuardToolOptions,
  GuardEngineOptions,
  GuardOnBlock,
  GuardBlockedValue,
} from './guard';

/** A secret that redactSecrets() or sanitizeToolResult() replaced. */
export interface SecretDetection {
  rule: string;
  /** Character offset of the secret in the input. */
  index: number;
}

export interface RedactResult {
  sanitized: string;
  detections: SecretDetection[];
}

export interface SanitizeToolResultOptions {
  /** Block output too large to scan in full (rule "size:truncated"). Also ZN_BLOCK_TRUNCATED=1. */
  blockTruncated?: boolean;
  /** Redact credentials from the returned content. Default true. */
  maskSecrets?: boolean;
  /** Also block the heuristic rules that are advisories by default. Also ZN_STRICT=1. */
  strict?: boolean;
}

export interface ToolResultReport {
  tool_name: string;
  safe_to_ingest: boolean;
  /** True when some part of the output was not scanned in full. */
  truncated: boolean;
  assessment: RuleAssessment;
  secrets_redacted: number;
  sanitized_content: string;
}

/**
 * Scans a tool output for indirect prompt injection and redacts secrets.
 * Local only; nothing is sent over the network.
 */
export function sanitizeToolResult(toolName: string, content: unknown, options?: SanitizeToolResultOptions): ToolResultReport;
/** Deep-redacts secrets in any string, array or object (no injection scan). */
export function sanitizeToolResult(value: unknown): { sanitized: unknown; detections: SecretDetection[] };

/** Replaces credentials in a text with placeholders. */
export function redactSecrets(text: string): RedactResult;

/** Event passed to logEvidence(). Only a short redacted preview and a SHA-256 of the payload are stored. */
export interface EvidenceEvent {
  agent?: string;
  agent_environment?: string;
  phase?: string;
  tool_name?: string;
  tool?: string;
  /** A string, or any JSON value (it is serialized). */
  payload?: unknown;
  verdict?: string;
  rule?: string | null;
  reason?: string | null;
  confidence?: number;
  latency_us?: number;
  engine?: string;
}

export interface EvidenceRecord {
  id: string;
  /** ISO 8601. */
  timestamp: string;
  agent_environment: string;
  phase: string;
  tool_name: string;
  payload_sha256: string;
  payload_preview: string;
  verdict: string;
  rule: string | null;
  reason: string | null;
  confidence: number;
  latency_us: number;
  engine: string;
  prev_hash: string;
  /** 64 lowercase hex characters. */
  record_hash: string;
}

export interface EvidenceVerification {
  valid: boolean;
  total: number;
  verified: number;
  /** Index of the first broken record, or null. */
  broken_index: number | null;
  error: string | null;
}

/**
 * Appends an event to the evidence log (default ~/.zn/evidence.jsonl). Returns the
 * record, or null when the write was skipped. It does not throw.
 */
export function logEvidence(event: EvidenceEvent, filePath?: string, opts?: { lockWaitMs?: number }): EvidenceRecord | null;

/** Verifies the SHA-256 chain of the evidence log. A damaged log gives valid: false, never an exception. */
export function verifyEvidenceLedger(filePath?: string): EvidenceVerification;
