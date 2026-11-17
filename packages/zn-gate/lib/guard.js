'use strict';

/*
 * Tool-call guard for agents and LLM applications (same verdict rules as the
 * Python package's check_tool_call / guard). Local only: nothing here touches
 * the network.
 */

const { types } = require('node:util');
const { evaluate, scanWindows, sanitizeToolResult, tooInvisible, invisibleBlock, truncatedBlocks } = require('./rules');

const MAX_DEPTH = 10;
const ON_BLOCK_VALUES = ['throw', 'return'];

/** Plain text for a blocked call or tool result: what was blocked, why, and the next step. */
function blockMessage(assessment, target) {
  const raw = String((assessment && assessment.reason) || '');
  let end = raw.length;
  while (end > 0 && raw.charCodeAt(end - 1) === 46) end--; // drop trailing dots in linear time
  const reason = raw.slice(0, end);
  const rule = assessment && assessment.rule;
  const why = reason ? `Reason: ${reason} (rule: ${rule}).` : `Reason: the input matched rule ${rule}.`;
  const isResult = /:(result|tool_output)$/.test(target);
  if (isResult && rule === 'size:truncated') {
    return `zn-gate blocked '${target}'. zn could not check this whole result (over 4 MB), so it was blocked. ` +
      'If you trust this tool, set ZN_ALLOW_TRUNCATED=1 (or pass allowTruncated: true) to let large results through without a full check.';
  }
  const step = isResult
    ? 'Next step: do not use this result; ask the person who runs this agent where the data came from.'
    : 'Next step: do not retry with reworded text; tell the person who runs this agent.';
  return `zn-gate blocked '${target}'. ${why} ${step}`;
}

/** Thrown when a guarded tool call or its result is blocked (onBlock: 'throw'). */
class GuardBlockError extends Error {
  constructor(assessment, target = '', payload = undefined) {
    super(blockMessage(assessment, target));
    this.name = 'GuardBlockError';
    this.code = 'ZN_GUARD_BLOCK';
    this.assessment = assessment;
    this.target = target;
    this.payload = payload;
  }
}

/** Internal: a payload is nested deeper than the scanner is willing to walk. */
class NestingTooDeep extends Error {}

/** Internal: a tool result holds a value that cannot be read without running its code. */
class Unscannable extends Error {}

// Prototypes of the built-in classes, compared by identity: their getters only show what the
// instance already holds. A prototype is never recognized by its constructor or a name, which
// any object can set.
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TRUSTED_PROTOTYPES = new Set([
  Object.prototype, Array.prototype, Map.prototype, Set.prototype, WeakMap.prototype, WeakSet.prototype,
  Date.prototype, RegExp.prototype, Promise.prototype, URL.prototype, URLSearchParams.prototype,
  ArrayBuffer.prototype, DataView.prototype, Number.prototype, String.prototype, Boolean.prototype,
  BigInt.prototype, Symbol.prototype, Buffer.prototype, TYPED_ARRAY_PROTOTYPE,
  ...[Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
    Float32Array, Float64Array, BigInt64Array, BigUint64Array].map((c) => c.prototype),
  ...[Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, AggregateError]
    .map((c) => c.prototype),
]);
if (typeof SharedArrayBuffer === 'function') TRUSTED_PROTOTYPES.add(SharedArrayBuffer.prototype);
if (typeof globalThis.Float16Array === 'function') TRUSTED_PROTOTYPES.add(globalThis.Float16Array.prototype);
// The `stack` accessor pair V8 puts on every error: it formats the stack the error already holds.
const ERROR_STACK = Object.getOwnPropertyDescriptor(new Error(), 'stack');
// The built-in iterators, so that a Set or a Map is read the same way whatever its own methods say.
const SET_VALUES = Set.prototype.values;
const MAP_ENTRIES = Map.prototype.entries;

function isErrorStack(key, d) {
  return key === 'stack' && ERROR_STACK !== undefined && ERROR_STACK.get !== undefined
    && d.get === ERROR_STACK.get && d.set === ERROR_STACK.set;
}

function isIndexKey(key) {
  return typeof key === 'string' && key !== '4294967295' && String(Number(key) >>> 0) === key;
}

/**
 * The own property descriptors of `obj`, or Unscannable when reading `obj` could run its code:
 * `obj` or one of its prototypes is a Proxy; it has an own getter or setter (listed or not); a
 * prototype other than a built-in one (TRUSTED_PROTOTYPES) defines one; or it is an array, a
 * Set, a Map or a typed array whose own or inherited Symbol.iterator is not the built-in one.
 * Nothing here calls a getter: on an object that is not a Proxy, reading descriptors runs no code.
 * Returns null for a typed array, whose elements are bytes and numbers.
 */
function screenObject(obj) {
  if (types.isProxy(obj)) throw new Unscannable();
  const typed = types.isTypedArray(obj);
  const container = typed || Array.isArray(obj) || types.isSet(obj) || types.isMap(obj);
  let own = null;
  if (typed) {
    // Its elements cannot be accessors; listing every index of a large buffer would be slow.
    for (const key of [Symbol.iterator, 'toJSON']) {
      const d = Object.getOwnPropertyDescriptor(obj, key);
      if (d && (d.get || d.set || key === Symbol.iterator)) throw new Unscannable();
    }
  } else {
    own = Object.getOwnPropertyDescriptors(obj);
    for (const key of Reflect.ownKeys(own)) {
      const d = own[key];
      if ((d.get || d.set) && !isErrorStack(key, d)) throw new Unscannable();
      if (container && key === Symbol.iterator) throw new Unscannable();
    }
  }
  for (let proto = Object.getPrototypeOf(obj); proto !== null; proto = Object.getPrototypeOf(proto)) {
    if (types.isProxy(proto)) throw new Unscannable();
    if (TRUSTED_PROTOTYPES.has(proto)) continue;
    const inherited = Object.getOwnPropertyDescriptors(proto);
    for (const key of Reflect.ownKeys(inherited)) {
      const d = inherited[key];
      if (d.get || d.set) throw new Unscannable();
      if (container && key === Symbol.iterator) throw new Unscannable();
    }
  }
  return own;
}

/**
 * A copy of a tool result made of plain data, built without running any of its code, or
 * Unscannable (see screenObject). Arrays, Sets and Maps are copied as the same kind of
 * container (read with the built-in iterators), typed arrays are kept as they are, and any
 * other object becomes a plain object of its listed (enumerable) string-keyed values, which
 * is all that extractStrings and sanitizeToolResult read. A container that contains itself
 * stays so in the copy. Throws NestingTooDeep where extractStrings would.
 * The result check reads this copy and masking rebuilds it, so both see the same values even
 * when the result would answer differently a second time.
 */
function snapshotOf(data, maxDepth, memo) {
  if (data === null || typeof data !== 'object') return data;
  if (memo.has(data)) return memo.get(data);
  const own = screenObject(data);
  if (types.isUint8Array(data)) { memo.set(data, data); return data; }
  if (maxDepth <= 0) throw new NestingTooDeep();
  if (own === null) { memo.set(data, data); return data; }
  if (Array.isArray(data)) {
    const out = new Array(own.length.value);
    memo.set(data, out);
    for (const key of Reflect.ownKeys(own)) {
      if (isIndexKey(key)) out[Number(key)] = snapshotOf(own[key].value, maxDepth - 1, memo);
    }
    return out;
  }
  if (types.isSet(data)) {
    const out = new Set();
    memo.set(data, out);
    for (const v of SET_VALUES.call(data)) out.add(snapshotOf(v, maxDepth - 1, memo));
    return out;
  }
  if (types.isMap(data)) {
    const out = new Map();
    memo.set(data, out);
    for (const entry of MAP_ENTRIES.call(data)) {
      out.set(snapshotOf(entry[0], maxDepth - 1, memo), snapshotOf(entry[1], maxDepth - 1, memo));
    }
    return out;
  }
  const out = {};
  memo.set(data, out);
  for (const key of Reflect.ownKeys(own)) {
    const d = own[key];
    if (typeof key !== 'string' || !d.enumerable || !('value' in d)) continue;
    // defineProperty, so a key such as __proto__ stays an ordinary property
    Object.defineProperty(out, key, {
      value: snapshotOf(d.value, maxDepth - 1, memo), enumerable: true, writable: true, configurable: true,
    });
  }
  return out;
}

const HIDDEN_ACCESSORS_REASON = 'An object shows values through getters, setters or a Proxy that cannot be checked '
  + 'without running its code; return its data as a plain object instead';

/**
 * Every string in a nested structure, object keys included. Walks arrays, sets,
 * maps (keys and values) and plain objects, and decodes Buffer / Uint8Array as
 * UTF-8. Throws NestingTooDeep instead of skipping content below the depth
 * limit, so callers can fail closed. A container that contains itself is walked
 * once.
 */
function extractStrings(data, maxDepth = MAX_DEPTH, path = new WeakSet(), out = []) {
  if (typeof data === 'string') { out.push(data); return out; }
  if (data instanceof Uint8Array) { out.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')); return out; }
  let children;
  if (Array.isArray(data) || data instanceof Set) {
    children = Array.from(data);
  } else if (data instanceof Map) {
    children = [];
    for (const [k, v] of data) children.push(k, v);
  } else if (data && typeof data === 'object') {
    children = [];
    for (const [k, v] of Object.entries(data)) children.push(k, v);
  } else {
    return out;
  }
  if (maxDepth <= 0) throw new NestingTooDeep();
  if (path.has(data)) return out;
  path.add(data);
  try {
    // Collected into one shared list: spreading a large child list into push() overflows the call stack.
    for (const child of children) extractStrings(child, maxDepth - 1, path, out);
    return out;
  } finally {
    path.delete(data);
  }
}

/**
 * extractStrings, or a block assessment when the payload is nested too deeply to check.
 * With snapshot (tool results), the strings are read from snapshotOf(data), returned as
 * `snapshot`, and a value that cannot be read without running its code is a block too.
 */
function stringsOrBlock(data, what, snapshot = false) {
  try {
    if (!snapshot) return { strings: extractStrings(data, MAX_DEPTH, new WeakSet(), []) };
    const copy = snapshotOf(data, MAX_DEPTH, new Map());
    return { strings: extractStrings(copy, MAX_DEPTH, new WeakSet(), []), snapshot: copy };
  } catch (e) {
    if (e instanceof Unscannable) {
      return {
        block: {
          allowed: false, verdict: 'block', confidence: 1.0, rule: 'type:unscannable',
          reason: `${what}: ${HIDDEN_ACCESSORS_REASON}`,
        },
      };
    }
    if (!(e instanceof NestingTooDeep)) throw e;
    return {
      block: {
        allowed: false, verdict: 'block', confidence: 1.0, rule: 'size:nesting',
        reason: `${what} nested too deeply to check`,
      },
    };
  }
}

function allow(advisory, extra) {
  const res = { allowed: true, verdict: 'allow', confidence: 1.0, rule: 'none', reason: null, ...extra };
  if (advisory) res.advisory = { ...advisory };
  return res;
}

/**
 * Decide whether an agent tool call is safe to run. Every string in `args`
 * (nested values and keys) is evaluated; the first block wins. Arguments nested
 * too deeply to check are blocked (rule size:nesting).
 * Returns { allowed, verdict, confidence, rule, reason, advisory? }.
 */
function checkToolCall(toolName, args, opts = {}) {
  let advisory = null;
  const { strings, block } = stringsOrBlock(args, 'Arguments');
  if (block) return block;
  for (const s of strings) {
    const res = evaluate(s, opts);
    if (res.verdict === 'block') return { allowed: false, ...res };
    advisory = advisory || res.advisory;
  }
  return allow(advisory);
}

/**
 * Decide whether data returned by a tool may enter the model context. Large
 * strings are scanned in overlapping windows; `truncated` is true when some
 * string was not scanned in full, and such output is blocked by default (rule
 * size:truncated); opts.allowTruncated or ZN_ALLOW_TRUNCATED=1 allows it.
 * A result holding a getter, a setter or a Proxy outside the built-in classes
 * is blocked (rule type:unscannable, see screenObject), as in the Python package.
 * Internal helper of guardTool; the public async variant is checkToolResult in lib/client.js.
 */
function scanToolResult(result, opts = {}) {
  return checkResultSnapshot(result, opts).assessment;
}

/** scanToolResult, plus the plain-data copy it checked (see snapshotOf) when the result is allowed. */
function checkResultSnapshot(result, opts) {
  let truncated = false;
  let advisory = null;
  const { strings, block, snapshot } = stringsOrBlock(result, 'Result', true);
  if (block) return { assessment: block };
  if (tooInvisible(strings)) return { assessment: { allowed: false, ...invisibleBlock() } };
  for (const s of strings) {
    const res = scanWindows(s, opts);
    if (res.verdict === 'block') return { assessment: { allowed: false, ...res } };
    truncated = truncated || res.truncated === true;
    advisory = advisory || res.advisory;
  }
  if (truncated && truncatedBlocks(opts)) {
    return {
      assessment: {
        allowed: false, verdict: 'block', confidence: 1.0, rule: 'size:truncated',
        reason: 'Output too large to scan in full', truncated: true,
      },
    };
  }
  return { assessment: allow(advisory, { truncated }), snapshot };
}

function validateOptions(opts) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new TypeError('guardTool: options must be an object');
  }
  const onBlock = opts.onBlock === undefined ? 'throw' : opts.onBlock;
  if (!ON_BLOCK_VALUES.includes(onBlock)) {
    const allowed = ON_BLOCK_VALUES.map((v) => "'" + v + "'").join(', ');
    throw new TypeError('guardTool: onBlock must be one of ' + allowed + ' (got ' + JSON.stringify(onBlock) + ')');
  }
  for (const key of ['checkArgs', 'checkResult', 'maskSecrets', 'blockTruncated', 'allowTruncated']) {
    if (opts[key] !== undefined && typeof opts[key] !== 'boolean') {
      throw new TypeError('guardTool: ' + key + ' must be a boolean');
    }
  }
  if (opts.onBlockCallback !== undefined && typeof opts.onBlockCallback !== 'function') {
    throw new TypeError('guardTool: onBlockCallback must be a function');
  }
  return onBlock;
}

/**
 * Wrap a sync or async function as a guarded tool. The call arguments are
 * checked before it runs and, with checkResult: true, its result before it
 * is returned.
 *
 * opts:
 *   name            tool name used in messages (default: fn.name)
 *   onBlock         'throw' (default; GuardBlockError) or 'return' (returns opts.fallback, or the assessment when no fallback is given)
 *   fallback        value returned when onBlock is 'return'
 *   checkArgs       check the arguments (default true)
 *   checkResult     check the return value (default false)
 *   maskSecrets     redact credentials in the returned value (default false)
 *   blockTruncated  with checkResult, block a result too large to scan in full (now the default)
 *   allowTruncated  with checkResult, allow such a result (it is marked truncated)
 *   onBlockCallback called as (assessment, name, payload) before the block is applied
 *   strict          passed to the rules engine
 * An unknown onBlock (or a wrongly typed option) throws a TypeError at wrap time.
 */
function guardTool(fn, opts = {}) {
  if (typeof fn !== 'function') throw new TypeError('guardTool: first argument must be a function');
  const onBlock = validateOptions(opts);
  const name = opts.name || fn.name || 'anonymous';
  const checkArgs = opts.checkArgs !== false;
  const engineOpts = opts.strict === undefined ? {} : { strict: opts.strict };

  const blocked = (assessment, target, payload) => {
    if (opts.onBlockCallback) opts.onBlockCallback(assessment, name, payload);
    if (onBlock === 'throw') throw new GuardBlockError(assessment, target, payload);
    return { value: opts.fallback !== undefined ? opts.fallback : assessment };
  };

  const before = (args) => {
    if (!checkArgs) return null;
    const payload = { args };
    const assessment = checkToolCall(name, payload, engineOpts);
    return assessment.allowed ? null : blocked(assessment, name, payload);
  };

  const after = (res) => {
    let checked = res;
    if (opts.checkResult) {
      const { assessment, snapshot } = checkResultSnapshot(res, { ...engineOpts, blockTruncated: opts.blockTruncated === true, allowTruncated: opts.allowTruncated === true });
      if (!assessment.allowed) return blocked(assessment, name + ':result', res).value;
      // Masking rebuilds the copy that was checked, so it cannot see other values than the check did.
      checked = snapshot;
    }
    return opts.maskSecrets ? sanitizeToolResult(checked).sanitized : res;
  };

  const isAsync = fn.constructor && fn.constructor.name === 'AsyncFunction';
  const wrapped = isAsync
    ? async function (...args) {
        const b = before(args);
        if (b) return b.value;
        return after(await fn.apply(this, args));
      }
    : function (...args) {
        const b = before(args);
        if (b) return b.value;
        const res = fn.apply(this, args);
        if (res && typeof res.then === 'function') return res.then(after);
        return after(res);
      };
  Object.defineProperty(wrapped, 'name', { value: fn.name, configurable: true });
  return wrapped;
}

module.exports = { checkToolCall, guardTool, GuardBlockError, blockMessage, extractStrings, scanToolResult, ON_BLOCK_VALUES };
