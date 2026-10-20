// Compiled by test/types-guard.test.js with `tsc --noEmit`. It is never run.
import { checkToolCall, guardTool, GuardBlockError } from '../../lib/client';
import type { ToolCallAssessment, GuardToolOptions } from '../../lib/client';
import { checkToolCall as checkFromGuard, guardTool as guardFromGuard } from '../../lib/guard';
import type { RuleAssessment } from '../../lib/guard';
import { redactSecrets, sanitizeToolResult, logEvidence, verifyEvidenceLedger } from '../../lib/client';

const call: ToolCallAssessment = checkToolCall('bash', { cmd: 'ls' }, { strict: true });
const allowed: boolean = call.allowed;
const rule: string = call.rule;
const reason: string | null = call.reason;
const same: boolean = checkFromGuard === checkToolCall;
const base: RuleAssessment = call;

function readFile(path: string): string {
  return path;
}

const guardedRead = guardTool(readFile, { name: 'read_file', checkResult: true });
const text: string | ToolCallAssessment = guardedRead('notes.txt');

const asyncFetch = guardTool(async (url: string): Promise<number> => url.length, { onBlock: 'return', fallback: -1 });
async function run(): Promise<void> {
  const n: Promise<number | ToolCallAssessment> = asyncFetch('https://example.test');
  void n;
}

const opts: GuardToolOptions<string> = {
  onBlock: 'return',
  fallback: 'blocked',
  onBlockCallback: (assessment, name, payload) => {
    const a: ToolCallAssessment = assessment;
    void [a, name, payload];
  },
};
const withFallback = guardTool(readFile, opts);
const r: string | ToolCallAssessment = withFallback('x');

try {
  guardedRead('../../etc/passwd');
} catch (err) {
  if (err instanceof GuardBlockError && err.code === 'ZN_GUARD_BLOCK') {
    const target: string = err.target;
    const verdict: 'allow' | 'block' = err.assessment.verdict;
    void [target, verdict];
  }
}

const red = redactSecrets('text');
const redacted: string = red.sanitized;
const report = sanitizeToolResult('fetch', 'body', { blockTruncated: true });
const out: string = report.sanitized_content;
const deep = sanitizeToolResult({ a: 'b' });
const ev = logEvidence({ tool_name: 'bash', verdict: 'block', payload: { cmd: 'x' } });
const hash: string | null = ev ? ev.record_hash : null;
const ok: boolean = verifyEvidenceLedger().valid;

void [allowed, rule, reason, same, base, text, r, redacted, out, deep, hash, ok, run];

// @ts-expect-error the verdict is only 'allow' or 'block'
const bad: 'maybe' = call.verdict;
// @ts-expect-error onBlock accepts only 'throw' or 'return'
guardTool(readFile, { onBlock: 'ignore' });
// @ts-expect-error unknown option
checkToolCall('bash', {}, { nope: true });
// @ts-expect-error the error code is a fixed literal
const code: 'other' = new GuardBlockError(call, 'x').code;
// @ts-expect-error a callback is required to be a function
guardTool(readFile, { onBlockCallback: 'log' });
void [bad, code];
