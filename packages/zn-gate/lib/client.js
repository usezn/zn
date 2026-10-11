'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { evaluate, redactSecrets, sanitizeToolResult, RULES_VERSION } = require('./rules');
let PKG_VERSION = '1.4.1';
try {
  PKG_VERSION = require('../package.json').version || '1.4.1';
} catch (_) {}

/*
 * Data-flow contract (since 1.4.1):
 *
 *  - Tool results, tool-call arguments and tool/parameter descriptions are
 *    evaluated ONLY in-process (analyzeLocal / checkToolResult). They never
 *    leave the machine, under any configuration.
 *  - The only code path that can reach the network is analyze() — the
 *    prompt-analysis API used by the `analyze_prompt` MCP tool and the
 *    `zn-gate analyze` CLI command — and only when BOTH ZN_API_KEY and
 *    ZN_CLOUD=1 are set (and ZN_LOCAL_ONLY is not "true"). Secrets are
 *    redacted locally with redactSecrets() before the request is built.
 */

function resolveEndpoint(options = {}) {
  if (options.apiUrl || process.env.ZN_API_URL) {
    return options.apiUrl || process.env.ZN_API_URL;
  }
  const stage = options.stage || process.env.ZN_STAGE || 'v30';
  if (stage === 'prod') {
    return 'https://api.usezn.com/prod/analyze';
  }
  return 'https://api.usezn.com/v30/analyze';
}

/**
 * True only when the user explicitly opted in to cloud prompt analysis:
 * an API key AND ZN_CLOUD=1, and no local-only override.
 */
function isCloudEnabled(options = {}) {
  const apiKey = options.apiKey || process.env.ZN_API_KEY;
  const optedIn = process.env.ZN_CLOUD === '1';
  const forceLocal = Boolean(options.localOnly) || process.env.ZN_LOCAL_ONLY === 'true';
  return Boolean(apiKey) && optedIn && !forceLocal;
}

function analyzeCloud(input, apiKey, endpointUrl, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpointUrl);
    const postData = JSON.stringify({ input });
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          Authorization: `Bearer ${apiKey.trim()}`,
          'User-Agent': `zn-gate/${PKG_VERSION} (mcp-client)`,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(body);
              const stageName = endpointUrl.includes('/v30') ? 'cloud-v30' : 'cloud-prod';
              resolve({ ...parsed, engine: stageName });
            } catch (err) {
              reject(new Error(`Failed to parse gateway response: ${err.message}`));
            }
          } else {
            reject(new Error(`Gateway responded with HTTP ${res.statusCode}: ${body.slice(0, 120)}`));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Gateway request timed out'));
    });

    req.on('error', (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

/**
 * Local-only evaluation. Never touches the network.
 * Used for tool results, tool-call arguments and tool descriptions.
 */
function analyzeLocal(input, options = {}) {
  const local = evaluate(input, options);
  return {
    ...local,
    mode: local.verdict === 'block' ? 'hybrid-local-fastpath' : 'oss-local',
  };
}

/**
 * Prompt analysis. Local rules first; optional cloud second opinion only when
 * the user opted in (ZN_API_KEY + ZN_CLOUD=1). The text is secret-redacted
 * locally before it is sent.
 */
async function analyze(input, options = {}) {
  const local = evaluate(input, options);
  if (local.verdict === 'block') {
    return {
      ...local,
      mode: 'hybrid-local-fastpath',
    };
  }

  if (!isCloudEnabled(options)) {
    return {
      ...local,
      mode: 'oss-local',
    };
  }

  const apiKey = options.apiKey || process.env.ZN_API_KEY;
  const { sanitized, detections } = redactSecrets(typeof input === 'string' ? input : String(input ?? ''));
  const endpoint = resolveEndpoint(options);
  try {
    const cloudRes = await analyzeCloud(sanitized, apiKey, endpoint, options.timeout || 4000);
    return {
      ...cloudRes,
      mode: 'hybrid-cloud',
      secrets_redacted_before_upload: detections.length,
    };
  } catch (err) {
    if (process.env.DEBUG || process.env.ZN_VERBOSE) {
      process.stderr.write(`[zn-gate] Warning: Cloud gate error (${err.message}). Using local rules result.\n`);
    }
    return {
      ...local,
      mode: 'oss-local',
      fallback: true,
      cloud_error: err.message,
    };
  }
}

/**
 * Inspect tool output before it enters the LLM context (indirect prompt
 * injection defense). Local only, and secrets are ALWAYS redacted from the
 * returned content via sanitizeToolResult().
 */
async function checkToolResult(toolName, content, options = {}) {
  const textContent = typeof content === 'string' ? content : JSON.stringify(content);

  // Fast-path for empty or tiny returns
  if (!textContent || textContent.length < 5) {
    return {
      tool_name: toolName,
      safe_to_ingest: true,
      secrets_redacted: 0,
      sanitized_content: textContent,
      assessment: { verdict: 'allow', confidence: 1.0, rule: 'none', engine: 'oss-local', mode: 'oss-local' },
    };
  }

  const res = sanitizeToolResult(String(toolName), textContent, { ...options, maskSecrets: true });
  return {
    ...res,
    assessment: { ...res.assessment, mode: res.safe_to_ingest ? 'oss-local' : 'hybrid-local-fastpath' },
  };
}

module.exports = {
  analyze,
  analyzeLocal,
  checkToolResult,
  isCloudEnabled,
  resolveEndpoint,
  evaluate,
  RULES_VERSION,
};
