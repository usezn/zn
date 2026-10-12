'use strict';

const fs = require('fs');
const path = require('path');

/**
 * zn deterministic rules engine - SINGLE SOURCE OF TRUTH.
 * RULES_VERSION: 2026-10-12.5
 */

const RULES_VERSION = '2026-10-12.5';

// "ignore" and "disregard" are ordinary words ("ignore the noise in the
// logs", "ignore whitespace changes"). They only count as an override when
// they name what to ignore: instructions, prompts, rules, guardrails... with a
// qualifier (previous, above, system...) or a quantifier (all, any, your...),
// or point back at earlier text ("ignore the above", "everything before").
// Every group is a fixed list of words and whitespace runs are bounded, so a
// match attempt does bounded work.
const OVERRIDE_NOUN_SOURCE =
  '(?:instructions?|prompts?|rules|guidelines?|directives?|guidance|restrictions?|guardrails?|context|constraints?|commands?|policies|programming|orders|limitations?|directions|requests?|tasks?)\\b';
const OVERRIDE_QUANTIFIER_SOURCE = '(?:all|any|every|each|your|my|these|those)(?:\\s{1,32}of)?\\s{1,32}';
const OVERRIDE_DETERMINER_SOURCE = '(?:(?:the|your|my|these|those|our|its|their)\\s{1,32})?';
const OVERRIDE_QUALIFIER_SOURCE =
  '(?:previous|prior|above|earlier|preceding|foregoing|original|initial|existing|system|safety|security|former|developer)\\s{1,32}';
// "ignore the above" / "ignore previous" without a noun counts only at the end
// of a clause, before "and" or before a word for text ("ignore the above
// text"), so "ignore the previous build output" stays allowed.
const OVERRIDE_END_SOURCE =
  '(?=[ \\t]*(?:[.,;:!)\\r\\n]|$)|\\s{1,32}and\\b|\\s{1,32}(?:text|content|message|messages|input|lines?|one|ones)\\b)';

function overrideRuleSource(verb) {
  return [
    `${verb}\\s{1,32}(?:${OVERRIDE_QUANTIFIER_SOURCE})?${OVERRIDE_DETERMINER_SOURCE}(?:${OVERRIDE_QUALIFIER_SOURCE}){1,2}${OVERRIDE_NOUN_SOURCE}`,
    `${verb}\\s{1,32}${OVERRIDE_QUANTIFIER_SOURCE}${OVERRIDE_DETERMINER_SOURCE}${OVERRIDE_NOUN_SOURCE}`,
    `${verb}\\s{1,32}(?:the\\s{1,32})?(?:instructions|guardrails|directives)\\b`,
    `${verb}\\s{1,32}(?:${OVERRIDE_QUANTIFIER_SOURCE})?(?:the\\s{1,32})?(?:previous|prior|above|earlier|preceding|foregoing)${OVERRIDE_END_SOURCE}`,
    `${verb}\\s{1,32}(?:everything|anything|all)\\s{1,32}(?:above|before|previously|prior|earlier|you(?:'ve|\\s{1,32}have|\\s{1,32}were|\\s{1,32}was)?\\s{1,32}(?:been\\s{1,32})?(?:told|said|given|received))\\b`,
  ].join('|');
}

// Russian and Chinese rules: a verb followed, within 80 characters on the same
// line, by an object ("забудь ... инструкции", "忽略 ... 指令"). A regex such
// as /忽略[^\n]{0,80}?(指令)/ is linear but reads up to 80 characters from
// every verb, which is slow on a long run of verbs. nearMatch() scans the verbs
// and the objects once each and compares their positions.
const NEAR_MAX_GAP = 80;
const RU_FORGET_RE = /забудь\s+/iu;
const RU_FORGET_OBJECT_RE = /все|инструкции/iu;
const RU_IGNORE_RE = /игнорируй\s+/iu;
const RU_IGNORE_OBJECT_RE = /все|предыдущие/iu;
const RU_PHRASE_RE = /действуй\s+как|ты\s+теперь|найди\s+пароли/iu;
const ZH_IGNORE_RE = /忽略/u;
const ZH_IGNORE_OBJECT_RE = /指示|指令|提示/u;
const ZH_FORGET_RE = /忘记/u;
const ZH_FORGET_OBJECT_RE = /指示|指令|一切/u;
const ZH_PHRASE_RE = /你现在是|初始提示词/u;

// True when an object match starts at most NEAR_MAX_GAP characters after the
// end of a verb match, with no line break in between. Linear: the object
// search only restarts past the last object found.
function nearMatch(text, verbRe, objectRe) {
  const verbs = new RegExp(verbRe.source, verbRe.flags + 'g');
  const objects = new RegExp(objectRe.source, objectRe.flags + 'g');
  let obj = null;
  let v;
  while ((v = verbs.exec(text)) !== null) {
    const end = v.index + v[0].length;
    if (obj === null || obj.index < end) {
      objects.lastIndex = end;
      obj = objects.exec(text);
      if (obj === null) return false;
    }
    if (obj.index - end <= NEAR_MAX_GAP && !text.slice(end, obj.index).includes('\n')) return true;
  }
  return false;
}

function testMultiRu(text) {
  return RU_PHRASE_RE.test(text) || nearMatch(text, RU_FORGET_RE, RU_FORGET_OBJECT_RE) || nearMatch(text, RU_IGNORE_RE, RU_IGNORE_OBJECT_RE);
}

function testMultiZh(text) {
  return ZH_PHRASE_RE.test(text) || nearMatch(text, ZH_IGNORE_RE, ZH_IGNORE_OBJECT_RE) || nearMatch(text, ZH_FORGET_RE, ZH_FORGET_OBJECT_RE);
}

const INJECTION_RULES = [
  { id: 'pi:ignore_previous', pattern: new RegExp(overrideRuleSource('ignore'), 'i'), description: 'Override prior instructions' },
  { id: 'pi:disregard', pattern: new RegExp(overrideRuleSource('disregard'), 'i'), description: 'Disregard instructions' },
  { id: 'pi:forget', pattern: /forget\s+(about\s+)?(everything|all|your)/i, description: 'Forget-context attack' },
  { id: 'pi:identity_override', pattern: /you\s+are\s+now/i, description: 'Identity override' },
  { id: 'pi:new_instructions', pattern: /new\s+instructions?:/i, description: 'Instruction replacement' },
  { id: 'pi:system_tag', pattern: /(?:^|[\r\n"'`\[<])[ \t]*system\s*:|<[\s/]*system\b[^<>]*>/i, description: 'Fake system tag' },
  { id: 'pi:system_bracket', pattern: /\[system\]/i, description: 'Bracketed system tag' },
  { id: 'pi:act_as', pattern: /act\s+as\s+(if|a)/i, description: 'Role hijack (act as)' },
  { id: 'pi:pretend', pattern: /pretend\s+(you|to\s+be)/i, description: 'Role hijack (pretend)' },
  { id: 'pi:roleplay', pattern: /roleplay\s+as/i, description: 'Role hijack (roleplay)' },
  { id: 'pi:jailbreak', pattern: /\bjailbreak\b/i, description: 'Explicit jailbreak term' },
  { id: 'pi:bypass', pattern: /bypass\s+(your|the|all)/i, description: 'Guardrail bypass attempt' },
  { id: 'pi:override', pattern: /\boverride\s+(?:all\s+|your\s+|the\s+)?(?:system|policy|safety|rules|instructions|guidelines|restrictions)\b|\bsystem\s+override\s*:/i, description: 'Policy override attempt' },
  { id: 'pi:template_boundary', pattern: /\[INST\]|\[\/INST\]|<<<SYS>>>|<\/<<SYS>>>|<\|im_start\|>|<\|im_end\|>/i, description: 'Chat template boundary injection' },
  { id: 'pi:multi_es', pattern: /ignora\s+(todas\s+las\s+)?(instrucciones|anteriores|previas)|olvida\s+(todo|las\s+instrucciones)|act[uú]a\s+como|ahora\s+eres/iu, description: 'Multilingual prompt injection (Spanish)' },
  { id: 'pi:multi_pt', pattern: /ignor(?:e|a|em|ar)\s+(?:(?:todas|todos|qualquer|quaisquer|cualquier)\s+)?(?:(?:as|os|las|los|suas|seus|sus|tus|estas|estes|essas|esses)\s+)?(?:instru[cç][oõ]es|instrucciones|regras|reglas|diretrizes|directrices|orienta[cç][oõ]es|ordens|[oó]rdenes|comandos|restri[cç][oõ]es|restricciones|mensagens|anteriores|pr[eé]vias)|ignore\s+(?:tudo|qualquer|quaisquer)\b|ignora\s+(?:todo|tudo|cualquier)\b/i, description: 'Multilingual prompt injection (Portuguese)' },
  { id: 'pi:multi_fr', pattern: /ignore[rz]?\s+(toutes\s+les\s+)?instructions|oublie[rz]?\s+tout|agis\s+comme|tu\s+es\s+maintenant/iu, description: 'Multilingual prompt injection (French)' },
  { id: 'pi:multi_de', pattern: /ignoriere\s+(alle\s+)?(anweisungen|instruktionen)|vergiss\s+(alles|jede)|du\s+bist\s+jetzt|handle\s+als/iu, description: 'Multilingual prompt injection (German)' },
  { id: 'pi:multi_ru', pattern: /забудь\s+[^\n]{0,80}?(все|инструкции)|игнорируй\s+[^\n]{0,80}?(все|предыдущие)|действуй\s+как|ты\s+теперь|найди\s+пароли/iu, test: testMultiRu, description: 'Multilingual prompt injection (Russian)' },
  { id: 'pi:multi_zh', pattern: /忽略[^\n]{0,80}?(指示|指令|提示)|忘记[^\n]{0,80}?(指示|指令|一切)|你现在是|初始提示词/u, test: testMultiZh, description: 'Multilingual prompt injection (Chinese)' },
];

// Hidden-element detection in two linear passes: find the first opening tag
// whose attributes hide it, then search once for a payload keyword after it.
// OPEN_TAG_RE always matches from a "<name" and consumes the attribute run up
// to the next "<" or ">", so every character is read once; the candidate is
// a tag only when that run is closed by ">". (A single regex with a lazy
// `[\s\S]*?` tail, or an attribute run that may cross "<", re-scans the rest
// of the input from every candidate and is super-linear on crafted markup.)
const OPEN_TAG_RE = /<[a-z0-9]+\b([^<>]*)(>?)/gi;
const HIDDEN_ATTR_RE = /\b(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|font-size\s*:\s*0(?:px)?|color\s*:\s*transparent|text-indent\s*:\s*-[0-9]{3,}px|hidden\b)/i;
const HIDDEN_PAYLOAD_RE = /ignore|system|instruction|prompt|bypass|override|exfil|leak/gi;

function testHiddenTag(text) {
  const tagRe = new RegExp(OPEN_TAG_RE.source, OPEN_TAG_RE.flags);
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    if (m[2] === '>' && HIDDEN_ATTR_RE.test(m[1])) {
      const payloadRe = new RegExp(HIDDEN_PAYLOAD_RE.source, HIDDEN_PAYLOAD_RE.flags);
      payloadRe.lastIndex = tagRe.lastIndex;
      return payloadRe.test(text);
    }
  }
  return false;
}

const INDIRECT_INJECTION_RULES = [
  {
    id: 'indirect:html_comment',
    pattern: /<!--\s*(?:system|instruction|prompt|override|command)\s*:/i,
    description: 'Hidden instruction in HTML comment',
  },
  {
    id: 'indirect:hidden_tag',
    // `.pattern` is the linear tag scanner; the rule itself is test().
    pattern: new RegExp(OPEN_TAG_RE.source, 'i'),
    test: testHiddenTag,
    description: 'Hidden DOM element with injection payload',
  },
];

const EVASION_RULES = [
  {
    id: 'evasion:bidi_override',
    pattern: /[\u202A-\u202E\u2066-\u2069]/,
    description: 'Unicode bidirectional override (Trojan Source evasion attempt)',
  },
];

const EXFIL_VERB_SOURCE = '\\b(give|reveal|send|show|print|expose|leak|paste|dump|read|open|cat|fetch|extract|steal)\\b';
const CRED_OBJECT_SOURCE =
  '\\b(passwords?|api[_ -]?keys?|secrets?|credentials?|tokens?|ssh[ _-]?keys?|private[ _-]?keys?|aws_secret[a-z0-9_]*|aws_access[a-z0-9_]*)\\b|(?:^|\\s|[\'"\`])\\.env(?:\\.[a-z0-9]+)?\\b';

const EXFIL_RULES = [
  {
    id: 'exfil:credentials',
    compound: [new RegExp(EXFIL_VERB_SOURCE, 'i'), new RegExp(CRED_OBJECT_SOURCE, 'i')],
    description: 'Imperative verb requesting credentials/secrets',
  },
];

const SENSITIVE_PATH_RULES = [
  {
    id: 'path:sensitive_file',
    pattern: /(?:^|[\s"'`(\[])(?:~|\/home\/[^\s/]+|\/root)?\/?\.(?:ssh\/(?:id_rsa|id_ed25519|authorized_keys)|aws\/credentials|env(?:\.[a-z0-9]+)?)\b|\/etc\/(?:shadow|passwd)\b/i,
    description: 'Targeting sensitive system credentials or environment file',
  },
];

// Markdown image exfiltration: ![alt](http(s)://host/...?key=value ...).
// MD_IMAGE_RE always matches from "![" and consumes the alt text and the URL
// once, so the scan is linear; the URL is then checked in code. Patterns that
// chain a lazy URL with a "[^)]*\)" tail re-scan the rest of the input from
// every "![" when no ")" follows.
const MD_IMAGE_RE = /!\[[^\]]*(?:\]\(([^\s)]*))?/gi;
const MD_URL_SCHEME_RE = /^https?:\/\/[^?&]/i;
const MD_URL_SECRET_PARAM_RE = /[?&](?:key|token|pass|secret|cred|data|val|leak|exfil)=/i;

function testMarkdownImage(text) {
  const closing = text.lastIndexOf(')');
  if (closing === -1) return false;
  const imgRe = new RegExp(MD_IMAGE_RE.source, MD_IMAGE_RE.flags);
  let m;
  while ((m = imgRe.exec(text)) !== null) {
    const url = m[1];
    if (url && imgRe.lastIndex <= closing && MD_URL_SCHEME_RE.test(url) && MD_URL_SECRET_PARAM_RE.test(url.slice(url.indexOf('//') + 2))) return true;
  }
  return false;
}

const MARKDOWN_EXFIL_RULES = [
  {
    id: 'exfil:markdown_image',
    // `.pattern` is the linear image scanner; the rule itself is test().
    pattern: new RegExp(MD_IMAGE_RE.source, 'i'),
    test: testMarkdownImage,
    description: 'Covert exfiltration via markdown image URL parameter',
  },
];

// Local custom rules cache (.znrules or zn.config.json)
let customConfig = null;
let lastConfigCheck = 0;

function loadCustomConfig(forceReload = false) {
  const now = Date.now();
  if (!forceReload && customConfig !== null && now - lastConfigCheck < 5000) {
    return customConfig;
  }
  lastConfigCheck = now;
  customConfig = { bannedPatterns: [], forbiddenPaths: [] };

  const candidates = [
    path.join(process.cwd(), '.znrules'),
    path.join(process.cwd(), 'zn.config.json'),
  ];

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        if (file.endsWith('.json')) {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (Array.isArray(parsed.bannedPatterns)) {
            customConfig.bannedPatterns = parsed.bannedPatterns.map((p) => new RegExp(p, 'i'));
          }
          if (Array.isArray(parsed.forbiddenPaths)) {
            customConfig.forbiddenPaths = parsed.forbiddenPaths;
          }
        } else {
          const lines = fs.readFileSync(file, 'utf8').split('\n');
          for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith('#')) continue;
            // `secret:` lines feed the scrubber's exact-value layer; they are
            // values, not patterns, and must never be compiled as regexes.
            if (line.startsWith('secret:')) continue;
            if (line.startsWith('path:')) {
              customConfig.forbiddenPaths.push(line.slice(5).trim());
            } else {
              customConfig.bannedPatterns.push(new RegExp(line, 'i'));
            }
          }
        }
      } catch (err) {
        // Silently ignore malformed custom configs in production
      }
      break;
    }
  }
  return customConfig;
}

const HOMOGLYPH_MAP = {
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c',
  '\u0456': 'i', '\u0455': 's', '\u0443': 'y', '\u0445': 'x',
  '\u0410': 'A', '\u0415': 'E', '\u041e': 'O', '\u0420': 'P', '\u0421': 'C',
};
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF\u00AD]/g;
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*\x07/g;
const B64_EXEC_RE = /(?:echo|printf)\s+([A-Za-z0-9+/=]{16,})\s*\|\s*(?:base64\s+-(?:d|-decode)|openssl)/i;

// Maximal whitespace runs; only runs that contain a line break are joined.
// A pattern anchored on the line break (such as /[^\S\r\n]*[\r\n]/) would
// rescan a long run of spaces from every position.
const WHITESPACE_RUN_RE = /\s+/g;
const LINE_BREAK_RE = /[\r\n]/;
const JOIN_LEFT_RE = /[\p{L}\p{N}_<|/.-]/u;
const JOIN_RIGHT_RE = /[\p{L}\p{N}_>|/.-]/u;

// Removes /* ... */ comments in one pass. An unterminated "/*" ends the
// search: no later comment can be closed either.
function stripCComments(str) {
  let start = str.indexOf('/*');
  if (start === -1) return str;
  let out = '';
  let from = 0;
  while (start !== -1) {
    const end = str.indexOf('*/', start + 2);
    if (end === -1) break;
    out += str.slice(from, start);
    from = end + 2;
    start = str.indexOf('/*', from);
  }
  return out + str.slice(from);
}

function normalizeInput(str) {
  if (typeof str !== 'string') return { normalized: '', stripped: '' };
  // 1. Strip zero-width evasion characters
  let stripped = str.replace(ZERO_WIDTH_RE, '');
  // 2. Strip ANSI escape sequences
  stripped = stripped.replace(ANSI_ESCAPE_RE, '');
  // 3. Strip inline C-style comments (e.g. sys/*safe*/tem -> system)
  stripped = stripCComments(stripped);
  // 4. Rejoin words and tokens split across newlines (e.g. sys\ntem -> system, /l\neak -> /leak, Cyrillic & Chinese).
  //    Linear: only the character on each side of a newline run is inspected.
  if (LINE_BREAK_RE.test(stripped)) {
    stripped = stripped.replace(WHITESPACE_RUN_RE, (run, offset, whole) => {
      if (!LINE_BREAK_RE.test(run)) return run;
      const left = offset > 0 ? whole[offset - 1] : '';
      const right = whole[offset + run.length] || '';
      return left && right && JOIN_LEFT_RE.test(left) && JOIN_RIGHT_RE.test(right) ? '' : run;
    });
  }
  // 5. Normalize homoglyphs (Cyrillic to Latin for English hijack detection)
  let normalized = stripped.replace(/[\u0410-\u0456]/g, (m) => HOMOGLYPH_MAP[m] || m);
  return { normalized, stripped };
}

// evaluate() analyses inputs longer than MAX_SCAN_CHARS as head + tail and
// marks the result `truncated: true`. Tool results are scanned in overlapping
// windows (up to MAX_TOOL_RESULT_SCAN_CHARS) by scanWindows() below.
const MAX_SCAN_CHARS = 256 * 1024;
const SCAN_HEAD_CHARS = 192 * 1024;
// One character is reserved for the separator, so the window fits the limit.
const SCAN_TAIL_CHARS = MAX_SCAN_CHARS - SCAN_HEAD_CHARS - 1;

function evaluateUncached(input, options = {}) {
  if (typeof input !== 'string') {
    return { verdict: 'allow', confidence: 1.0, rule: 'none', reason: null, engine: 'oss-local', rules_version: RULES_VERSION };
  }
  if (input.length > MAX_SCAN_CHARS) {
    // NUL is neither whitespace nor a word character, so normalization cannot
    // join the end of the head and the start of the tail into a new token.
    const window = input.slice(0, SCAN_HEAD_CHARS) + '\u0000' + input.slice(-SCAN_TAIL_CHARS);
    return { ...evaluateUncached(window, options), truncated: true };
  }

  // Pre-normalization passes: stripped (preserves non-Latin) and normalized (maps homoglyphs)
  const { normalized, stripped } = normalizeInput(input);

  // Check Base64 payload smuggling
  const b64Match = normalized.match(B64_EXEC_RE) || stripped.match(B64_EXEC_RE);
  if (b64Match && b64Match[1]) {
    try {
      const decoded = Buffer.from(b64Match[1], 'base64').toString('utf8');
      const innerRes = evaluate(decoded, options);
      if (innerRes.verdict === 'block') {
        return {
          ...innerRes,
          reason: `Smuggled Base64 execution: ${innerRes.reason || innerRes.rule}`,
          rule: 'evasion:base64_smuggling',
        };
      }
    } catch (e) {
      // ignore invalid base64
    }
  }

  // Check against normalized, stripped, and raw input
  const targets = Array.from(new Set([normalized, stripped, input]));

  for (const text of targets) {
    // 0. Evasion Rules (BiDi Trojan Source)
    for (const rule of EVASION_RULES) {
      if (rule.pattern.test(text)) {
        return { verdict: 'block', confidence: 0.99, reason: rule.description, rule: rule.id, engine: 'oss-local', rules_version: RULES_VERSION };
      }
    }

    // 1. Covert Markdown Image Exfiltration
    for (const rule of MARKDOWN_EXFIL_RULES) {
      if (rule.test ? rule.test(text) : rule.pattern.test(text)) {
        return { verdict: 'block', confidence: 0.98, reason: rule.description, rule: rule.id, engine: 'oss-local', rules_version: RULES_VERSION };
      }
    }

    // 2. Sensitive Path Traversal / Credential File Access
    for (const rule of SENSITIVE_PATH_RULES) {
      if (rule.pattern.test(text)) {
        return { verdict: 'block', confidence: 0.92, reason: rule.description, rule: rule.id, engine: 'oss-local', rules_version: RULES_VERSION };
      }
    }

    // 3. Indirect Injection Rules (HTML comments / hidden elements)
    for (const rule of INDIRECT_INJECTION_RULES) {
      if (rule.test ? rule.test(text) : rule.pattern.test(text)) {
        return { verdict: 'block', confidence: 0.95, reason: rule.description, rule: rule.id, engine: 'oss-local', rules_version: RULES_VERSION };
      }
    }

    // 4. Standard Prompt Injection Rules
    for (const rule of INJECTION_RULES) {
      if (rule.test ? rule.test(text) : rule.pattern.test(text)) {
        return { verdict: 'block', confidence: 0.95, reason: rule.description, rule: rule.id, engine: 'oss-local', rules_version: RULES_VERSION };
      }
    }

    // 5. Exfiltration Rules
    for (const rule of EXFIL_RULES) {
      if (rule.compound.every((re) => re.test(text))) {
        return { verdict: 'block', confidence: 0.9, reason: rule.description, rule: rule.id, engine: 'oss-local', rules_version: RULES_VERSION };
      }
    }
  }

  // 6. Project-specific Custom Rules (.znrules / zn.config.json)
  const cfg = loadCustomConfig();
  for (const pat of cfg.bannedPatterns) {
    if (pat.test(input)) {
      return { verdict: 'block', confidence: 1.0, reason: `Matches custom repository rule: ${pat.source}`, rule: 'custom:banned_pattern', engine: 'oss-local', rules_version: RULES_VERSION };
    }
  }
  for (const fpath of cfg.forbiddenPaths) {
    if (input.includes(fpath)) {
      return { verdict: 'block', confidence: 1.0, reason: `Matches custom repository forbidden path: ${fpath}`, rule: 'custom:forbidden_path', engine: 'oss-local', rules_version: RULES_VERSION };
    }
  }

  return { verdict: 'allow', confidence: 0.99, rule: 'none', reason: null, engine: 'oss-local', rules_version: RULES_VERSION };
}

// -------------------------------------------------------------------------
// DLP & Secret Masking Rules
// -------------------------------------------------------------------------
const SECRET_PATTERNS = [
  // A body may not contain another BEGIN header: linear on repeated headers without END.
  { id: 'secret:private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?!-----BEGIN )[\s\S])*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  { id: 'secret:anthropic_key', pattern: /(?<![A-Za-z0-9_])(sk-ant-[A-Za-z0-9_-]{30,})(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))/g, replacement: '[REDACTED_ANTHROPIC_KEY]' },
  // A key without a known prefix ends at the first character that is not a letter or digit.
  { id: 'secret:openai_key', pattern: /(?<![A-Za-z0-9_])(sk-(?:(?:proj|svcacct|admin|[Nn]one|or-v1|lf)-[A-Za-z0-9_-]{28,}(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))|helicone-(?:(?:eu|cp|gov|rl)-){0,4}[a-z0-9]{7}(?:-[a-z0-9]{7}){3}(?![a-z0-9])|(?=(?:eu|cp|gov|rl)-|[a-z0-9]{7}-)(?=[a-z-]{0,46}[0-9])(?:(?:eu|cp|gov|rl)-){0,4}[a-z0-9]{7}(?:-[a-z0-9]{7}){3}(?![a-z0-9])(?!-[a-z0-9])|sp-[A-Za-z0-9]{28,}(?![A-Za-z0-9])|[A-Za-z0-9]{28,}(?![A-Za-z0-9])|(?:(?!sk-)[A-Za-z0-9_-]){1,200}?T3BlbkFJ[A-Za-z0-9_-]{20,}(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))))/g, replacement: '[REDACTED_OPENAI_KEY]' },
  { id: 'secret:aws_access_key', pattern: /(?<![A-Za-z0-9_])(AKIA[0-9A-Z]{16})(?![A-Za-z0-9_])/g, replacement: '[REDACTED_AWS_KEY]' },
  { id: 'secret:aws_secret_key', pattern: /((?:[Aa][Ww][Ss]_[Ss][Ee][Cc][Rr][Ee][Tt]_[Aa][Cc][Cc][Ee][Ss][Ss]_[Kk][Ee][Yy]|[Aa][Ww][Ss]_[Ss][Ee][Cc][Rr][Ee][Tt]|[Aa][Ww][Ss]_[Kk][Ee][Yy])\s*[:=]\s*['"]?)([A-Za-z0-9/+=]{40})(['"]?)/g, replacement: '$1[REDACTED_AWS_SECRET]$3' },
  { id: 'secret:github_token', pattern: /(?<![A-Za-z0-9_])((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,40}|github_pat_[A-Za-z0-9_]{82})(?![A-Za-z0-9_])/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { id: 'secret:db_url_password', pattern: /((?:[Pp][Oo][Ss][Tt][Gg][Rr][Ee][Ss](?:[Qq][Ll])?|[Mm][Yy][Ss][Qq][Ll]|[Mm][Oo][Nn][Gg][Oo][Dd][Bb](?:\+[Ss][Rr][Vv])?|[Rr][Ee][Dd][Ii][Ss]|[Aa][Mm][Qq][Pp]):\/\/[^:\s\/]+:)([^@\s\/]+)(@)/g, replacement: '$1[REDACTED_DB_PASSWORD]$3' },
  // The lookahead + backreference pairs act as atomic groups, so a long run of
  // "-eyJ" cannot make the engine retry every split point, and the lookbehind
  // allows a single start per token. Only used when the
  // text contains ".eyJ" (see redactSecrets).
  { id: 'secret:jwt_token', pattern: /(?<![A-Za-z0-9_-])(eyJ(?=([A-Za-z0-9_-]{10,512}))\2\.eyJ(?=([A-Za-z0-9_=-]{10,8192}))\3\.[A-Za-z0-9_.+/=-]{10,4096})(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))/g, replacement: '[REDACTED_JWT]', requires: '.eyJ' },
  { id: 'secret:env_credential', pattern: /(?<![A-Za-z0-9_])((?:[Aa][Ww][Ss]_[Ss][Ee][Cc][Rr][Ee][Tt]_[Aa][Cc][Cc][Ee][Ss][Ss]_[Kk][Ee][Yy]|[Ss][Ee][Cc][Rr][Ee][Tt]_[Kk][Ee][Yy]|[Aa][Pp][Ii]_[Kk][Ee][Yy]|[Aa][Uu][Tt][Hh]_[Tt][Oo][Kk][Ee][Nn]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee]_[Kk][Ee][Yy]|[Dd][Aa][Tt][Aa][Bb][Aa][Ss][Ee]_[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd])\s*[:=]\s*['"]?)([^\s'"]{12,})(['"]?)/g, replacement: '$1[REDACTED_SECRET]$3' },
];

function redactSecrets(text) {
  if (typeof text !== 'string' || !text) {
    return { sanitized: text, detections: [] };
  }
  let sanitized = text;
  const detections = [];
  for (const item of SECRET_PATTERNS) {
    if (item.requires && !sanitized.includes(item.requires)) continue;
    let match;
    const regex = new RegExp(item.pattern.source, item.pattern.flags);
    while ((match = regex.exec(sanitized)) !== null) {
      detections.push({
        rule: item.id,
        index: match.index,
      });
    }
    sanitized = sanitized.replace(item.pattern, item.replacement);
  }
  return { sanitized, detections };
}

// Tool output can be large (file reads, search results). Instead of the
// head + tail view used by evaluate(), it is scanned in windows of
// MAX_SCAN_CHARS that overlap by SCAN_WINDOW_OVERLAP, so a payload in the
// middle is not skipped. Past MAX_TOOL_RESULT_SCAN_CHARS only the last window
// is added and the result is marked `truncated: true`. A match that spans more
// than SCAN_WINDOW_OVERLAP characters across a window boundary can be missed.
const SCAN_WINDOW_OVERLAP = 4 * 1024;
const MAX_TOOL_RESULT_SCAN_CHARS = 4 * 1024 * 1024;

function scanWindows(text, options = {}) {
  if (typeof text !== 'string' || text.length <= MAX_SCAN_CHARS) return evaluate(text, options);
  const step = MAX_SCAN_CHARS - SCAN_WINDOW_OVERLAP;
  const limit = Math.min(text.length, MAX_TOOL_RESULT_SCAN_CHARS);
  let res = null;
  for (let start = 0; ; start += step) {
    const end = Math.min(start + MAX_SCAN_CHARS, limit);
    res = evaluateUncached(text.slice(start, end), options);
    if (res.verdict === 'block' || end >= limit) break;
  }
  if (res.verdict !== 'block' && text.length > limit) {
    res = evaluateUncached(text.slice(-MAX_SCAN_CHARS), options);
  }
  res = { ...res };
  delete res.truncated;
  if (text.length > limit) res.truncated = true;
  return res;
}

function sanitizeToolResult(toolOrResult, content, options = {}) {
  if (content !== undefined && content !== null) {
    const toolName = String(toolOrResult);
    const textContent = typeof content === 'string' ? content : JSON.stringify(content);
    const assessment = scanWindows(textContent, options);
    const truncated = assessment.truncated === true;
    // Output too large to scan in full is allowed (with `truncated: true`)
    // unless the caller opts into blocking it.
    const blockTruncated = options.blockTruncated === true || process.env.ZN_BLOCK_TRUNCATED === '1';
    if (truncated && blockTruncated && assessment.verdict !== 'block') {
      assessment.verdict = 'block';
      assessment.confidence = 1.0;
      assessment.rule = 'size:truncated';
      assessment.reason = 'Output too large to scan in full';
    }
    const isBlock = assessment.verdict?.toLowerCase() === 'block';

    let sanitized = textContent;
    let secretsRedacted = 0;

    if (isBlock) {
      sanitized = `[REDACTED BY ZN-GATE: Malicious prompt injection payload detected in ${toolName} output (${assessment.reason || assessment.rule})]`;
    } else if (options.maskSecrets !== false) {
      const res = redactSecrets(textContent);
      sanitized = res.sanitized;
      secretsRedacted = res.detections.length;
    }

    return {
      tool_name: toolName,
      safe_to_ingest: !isBlock,
      truncated,
      assessment,
      secrets_redacted: secretsRedacted,
      sanitized_content: sanitized,
    };
  }

  // Deep sanitization of objects/arrays
  const detections = [];
  function _sanitize(val) {
    if (typeof val === 'string') {
      const res = redactSecrets(val);
      if (res.detections.length > 0) {
        detections.push(...res.detections);
      }
      return res.sanitized;
    } else if (Array.isArray(val)) {
      return val.map(_sanitize);
    } else if (val !== null && typeof val === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(val)) {
        out[k] = _sanitize(v);
      }
      return out;
    }
    return val;
  }

  const sanitized = _sanitize(toolOrResult);
  return { sanitized, detections };
}

// LRU cache for evaluate(): max 2048 entries keyed on raw input, only for
// inputs up to 8 KB so the cache itself stays small.
// Invalidated when RULES_VERSION changes or custom config reloads.
const EVAL_CACHE_MAX = 2048;
const EVAL_CACHE_MAX_INPUT = 8 * 1024;
const evalCache = new Map();
function evaluate(input, options = {}) {
  if (typeof input !== 'string' || input.length > EVAL_CACHE_MAX_INPUT) return evaluateUncached(input, options);
  const cfg = loadCustomConfig();
  const hit = evalCache.get(input);
  if (hit !== undefined && hit.ver === RULES_VERSION && hit.cfg === cfg) {
    evalCache.delete(input);
    evalCache.set(input, hit);
    return { ...hit.res };
  }
  const res = evaluateUncached(input, options);
  evalCache.set(input, { res, cfg, ver: RULES_VERSION });
  if (evalCache.size > EVAL_CACHE_MAX) {
    evalCache.delete(evalCache.keys().next().value);
  }
  return { ...res };
}

module.exports = {
  evaluate,
  analyzePrompt: evaluate,
  loadCustomConfig,
  redactSecrets,
  sanitizeToolResult,
  normalizeInput,
  scanWindows,
  MAX_SCAN_CHARS,
  MAX_TOOL_RESULT_SCAN_CHARS,
  SCAN_WINDOW_OVERLAP,
  SCAN_HEAD_CHARS,
  SCAN_TAIL_CHARS,
  EVAL_CACHE_MAX_INPUT,
  // Helper patterns used by normalization and the hidden-element check,
  // exported so the Python port can be checked against them.
  HELPER_PATTERNS: { ZERO_WIDTH_RE, ANSI_ESCAPE_RE, B64_EXEC_RE, WHITESPACE_RUN_RE, OPEN_TAG_RE, HIDDEN_ATTR_RE, HIDDEN_PAYLOAD_RE, MD_IMAGE_RE, MD_URL_SCHEME_RE, MD_URL_SECRET_PARAM_RE,
    RU_FORGET_RE, RU_FORGET_OBJECT_RE, RU_IGNORE_RE, RU_IGNORE_OBJECT_RE, RU_PHRASE_RE,
    ZH_IGNORE_RE, ZH_IGNORE_OBJECT_RE, ZH_FORGET_RE, ZH_FORGET_OBJECT_RE, ZH_PHRASE_RE,
  },
  SECRET_PATTERNS,
  RULES_VERSION,
  INJECTION_RULES,
  INDIRECT_INJECTION_RULES,
  EVASION_RULES,
  EXFIL_RULES,
  SENSITIVE_PATH_RULES,
  MARKDOWN_EXFIL_RULES,
};
