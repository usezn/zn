// Type definitions for zn-gate/lib/evidence (hash-chained evidence log). Hand-written; keep in step with lib/evidence.js.

export interface EvidenceEvent {
  agent?: string;
  agent_environment?: string;
  phase?: string;
  tool_name?: string;
  tool?: string;
  /** A string, or any JSON value (it is serialized). Only a short redacted preview and a SHA-256 are stored. */
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

export interface LogEvidenceOptions {
  /** How long to wait for the write lock, in milliseconds. */
  lockWaitMs?: number;
}

/** Default path: ~/.zn/evidence.jsonl. */
export const EVIDENCE_FILE: string;

/**
 * Appends an event to the log. Returns the record, or null when the write was
 * skipped (damaged log, busy lock, no permission). It does not throw.
 */
export function logEvidence(event: EvidenceEvent, filePath?: string, opts?: LogEvidenceOptions): EvidenceRecord | null;

/** Verifies the SHA-256 chain of the log. A damaged log gives valid: false, never an exception. */
export function verifyEvidenceLedger(filePath?: string): EvidenceVerification;
