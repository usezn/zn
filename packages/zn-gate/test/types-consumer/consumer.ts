// Compiled by test/types-consumer.test.js with `tsc --noEmit`. It is never run.
// Imports every name the shipped .d.ts files declare, from each entry point, and uses it in a typed way.
// test/types-consumer.test.js checks that this file mentions every exported name.
import {
  analyze, analyzeLocal, checkToolResult, longInputMode, isCloudEnabled, usesStoredKey, usableApiKey,
  resolveEndpoint, LONG_INPUT_MIN_CHARS, evaluate, RULES_VERSION, sanitizeToolResult, redactSecrets,
  logEvidence, verifyEvidenceLedger, checkToolCall, guardTool, GuardBlockError,
} from '../..';
import type {
  Assessment, Advisory, EvaluateOptions, SanitizeToolResultOptions, SecretDetection, RedactResult,
  EvidenceEvent, EvidenceRecord, EvidenceVerification, RuleAssessment, ToolCallAssessment, GuardToolOptions,
  GuardEngineOptions, GuardOnBlock, GuardBlockedValue, LongInputMode, AnalyzeOptions, LongInputInfo,
  AnalyzeResult, ToolResultAssessment, CheckedToolResult, ResolveEndpointOptions,
} from '../..';
import {
  evaluate as ruleEvaluate, RULES_VERSION as RULES_VERSION_2, redactSecrets as redact2, sanitizeToolResult as sanitize2,
} from '../../lib/rules';
import type {
  Advisory as RAdvisory, Assessment as RAssessment, EvaluateOptions as REvaluateOptions, RedactResult as RRedactResult,
  SanitizeToolResultOptions as RSanitizeOptions, SecretDetection as RSecretDetection, ToolResultReport,
} from '../../lib/rules';
import { EVIDENCE_FILE, logEvidence as log2, verifyEvidenceLedger as verify2 } from '../../lib/evidence';
import type {
  EvidenceEvent as EEvent, EvidenceRecord as ERecord, EvidenceVerification as EVerification, LogEvidenceOptions,
} from '../../lib/evidence';
import {
  checkToolCall as check2, guardTool as guard2, GuardBlockError as BlockError2,
} from '../../lib/guard';
import type {
  RuleAssessment as GRuleAssessment, ToolCallAssessment as GToolCall, GuardEngineOptions as GEngine,
  GuardOnBlock as GOnBlock, GuardToolOptions as GToolOptions, GuardBlockedValue as GBlocked,
} from '../../lib/guard';

async function main(): Promise<void> {
  // client entry point
  const opts: AnalyzeOptions = { apiKey: 'k', localOnly: true, apiUrl: 'https://example.invalid', stage: 'v30', timeout: 1, longInput: 'off', strict: true };
  const res: AnalyzeResult = await analyze('x', opts);
  const mode: 'oss-local' | 'hybrid-local-fastpath' | 'hybrid-cloud' = res.mode;
  const info: LongInputInfo | undefined = res.long_input;
  const wins: number | undefined = info?.windows;
  const loc: AnalyzeResult = analyzeLocal('x', { strict: false });
  const tr: CheckedToolResult = await checkToolResult('t', 'c', { maskSecrets: true });
  const tra: ToolResultAssessment = tr.assessment;
  const reason: string | null | undefined = tra.reason;
  const lim: LongInputMode = longInputMode({ longInput: 'windows' });
  const min: number = LONG_INPUT_MIN_CHARS;
  const cloud: boolean = isCloudEnabled(opts) && usesStoredKey(opts);
  const key: string | null = usableApiKey('x');
  const ro: ResolveEndpointOptions = { apiUrl: 'https://example.invalid', stage: 'prod' };
  const url: string = resolveEndpoint(ro, { stored: true });

  // rules
  const ev: Assessment = evaluate('x', { strict: true });
  const verdict: 'allow' | 'block' = ev.verdict;
  const adv: Advisory | null | undefined = ev.advisory;
  const eo: EvaluateOptions = {};
  const so: SanitizeToolResultOptions = { blockTruncated: true, allowTruncated: false, maskSecrets: true, strict: false };
  const red: RedactResult = redactSecrets('x');
  const det: SecretDetection[] = red.detections;
  const rep = sanitizeToolResult('t', 'c', so);
  const deep = sanitizeToolResult({ a: 1 });
  const rv: string = RULES_VERSION + RULES_VERSION_2;
  const ev2: RAssessment = ruleEvaluate('x');
  const radv: RAdvisory | null | undefined = ev2.advisory;
  const reo: REvaluateOptions = eo;
  const rrr: RRedactResult = redact2('x');
  const rso: RSanitizeOptions = so;
  const rsd: RSecretDetection | undefined = rrr.detections[0];
  const report: ToolResultReport = sanitize2('t', 'c');
  const sanitized2: string = report.sanitized_content;

  // evidence
  const event: EvidenceEvent = { agent: 'a', phase: 'pre', tool_name: 'bash', payload: { c: 1 }, verdict: 'block', rule: null, confidence: 1, latency_us: 1 };
  const lo: LogEvidenceOptions = { lockWaitMs: 10 };
  const rec: EvidenceRecord | null = logEvidence(event, EVIDENCE_FILE, lo);
  const rec2: ERecord | null = log2(event as EEvent);
  const ver: EvidenceVerification = verifyEvidenceLedger(EVIDENCE_FILE);
  const ver2: EVerification = verify2();
  const broken: number | null = ver.broken_index;

  // guard
  const ge: GuardEngineOptions = { strict: true };
  const ge2: GEngine = ge;
  const call: ToolCallAssessment = checkToolCall('t', { a: 'b' }, ge2);
  const call2: GToolCall = check2('t', 'x');
  const base: RuleAssessment = call;
  const base2: GRuleAssessment = base;
  const onBlock: GuardOnBlock = 'return';
  const onBlock2: GOnBlock = onBlock;
  const go: GuardToolOptions<string> = {
    name: 'n', onBlock, fallback: 'f', checkArgs: true, checkResult: true, maskSecrets: true, blockTruncated: false,
    allowTruncated: false, strict: true, onBlockCallback: (a: ToolCallAssessment, n: string, p: unknown) => { void [a.allowed, n, p]; },
  };
  const go2: GToolOptions<string> = go;
  const sync = guardTool((a: number) => a + 1, { onBlock: 'return', fallback: 'blocked' });
  const sv: number | GuardBlockedValue<string> = sync(1);
  const asy = guard2(async (a: string) => a.length, go2);
  const av: number | GBlocked<string> = await asy('x');
  try { sync(2); } catch (e) {
    if (e instanceof GuardBlockError) {
      const name: 'GuardBlockError' = e.name;
      const code: 'ZN_GUARD_BLOCK' = e.code;
      const a: ToolCallAssessment = e.assessment;
      void [name, code, a, e.target, e.payload];
    }
  }
  const made: Error = new BlockError2(call, 'tool', { args: [] });

  void [mode, wins, loc, reason, lim, min, cloud, key, url, verdict, adv, red, det, rep, deep, rv, radv, reo, rsd, rso, sanitized2,
    rec, rec2, ver2, broken, call2, base2, onBlock2, sv, av, made];
}
void main;
