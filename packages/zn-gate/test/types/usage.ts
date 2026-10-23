// Compiled by test/types.test.js with `tsc --noEmit`. It is never run.
// Importing the package directory (../..) resolves through the "types" field of package.json.
import { analyze, analyzeLocal, checkCommand, checkToolResult, evaluate, longInputMode, RULES_VERSION } from '../..';
import type { AnalyzeResult, Assessment } from '../..';
import { redactSecrets, sanitizeToolResult } from '../../lib/rules';
import { logEvidence, verifyEvidenceLedger } from '../../lib/evidence';

const local = evaluate('hello');
const verdict: 'allow' | 'block' = local.verdict;
const reason: string | null = local.reason;
const version: string = RULES_VERSION;

async function main(): Promise<void> {
  const res: AnalyzeResult = await analyze('hello', { localOnly: true, timeout: 1000 });
  const mode: 'oss-local' | 'hybrid-local-fastpath' | 'hybrid-cloud' = res.mode;
  const sync: AnalyzeResult = analyzeLocal('hello', { strict: true });
  const tool = await checkToolResult('fetch', { a: 1 }, { blockTruncated: true });
  const safe: boolean = tool.safe_to_ingest;
  const out: string = tool.sanitized_content;
  const lim: 'off' | 'windows' = longInputMode({ longInput: 'off' });
  const red = redactSecrets('x');
  const n: number = red.detections.length;
  const rep = sanitizeToolResult('fetch', 'text');
  const cnt: number = rep.secrets_redacted;
  const deep = sanitizeToolResult({ k: 'v' });
  const rec = logEvidence({ tool_name: 'bash', verdict: 'block', payload: { cmd: 'x' } });
  const hash: string | null = rec ? rec.record_hash : null;
  const ok: boolean = verifyEvidenceLedger().valid;
  void [verdict, reason, version, mode, sync, safe, out, lim, n, cnt, deep, hash, ok];
}
void main;

// @ts-expect-error evaluate takes a string
evaluate(42);
// @ts-expect-error the verdict is only 'allow' or 'block'
const bad: 'maybe' = evaluate('x').verdict;
// @ts-expect-error unknown option
analyzeLocal('x', { nope: true });
// @ts-expect-error checkToolResult needs a tool name and content
checkToolResult('only-name');
void bad;

const cmd: Assessment = checkCommand('ls -la');
const cmdVerdict: 'allow' | 'block' = cmd.verdict;
void cmdVerdict;
// @ts-expect-error checkCommand takes the command text
checkCommand(42);
