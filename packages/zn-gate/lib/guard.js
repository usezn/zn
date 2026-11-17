'use strict';

/*
 * Tool-call guard for agents and LLM applications (same verdict rules as the
 * Python package's check_tool_call / guard). Local only: nothing here touches
 * the network.
 */

const util = require('node:util');
const { types } = util;
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
// Keys through which an object decides what it becomes when it is serialized (JSON.stringify),
// converted to text or a number, printed, or awaited. A function stored under one of them runs
// after the check, so it could produce text that was never checked.
const HOOK_KEYS = new Set(['toJSON', 'toString', 'valueOf', 'toISOString', 'then', Symbol.toPrimitive, util.inspect.custom]);
// Built-in readers, called on objects whose class is known so that no code of the result runs.
const URL_CLASS = URL;
const URL_HREF = Object.getOwnPropertyDescriptor(URL.prototype, 'href').get;
const PROMISE_THEN = Promise.prototype.then;
const STRING_VALUE = String.prototype.valueOf;
const NUMBER_VALUE = Number.prototype.valueOf;
const BOOLEAN_VALUE = Boolean.prototype.valueOf;
const DATE_CLASS = Date;
const DATE_TIME = Date.prototype.getTime;
const REGEXP_SOURCE = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get;
const REGEXP_FLAGS = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags').get;
const SYMBOL_DESCRIPTION = Object.getOwnPropertyDescriptor(Symbol.prototype, 'description').get;
const TYPED_ARRAY_TAG = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag).get;
const TYPED_ARRAY_CLASSES = new Map([Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array,
  Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
  ...(typeof globalThis.Float16Array === 'function' ? [globalThis.Float16Array] : [])].map((c) => [c.name, c]));
const UINT8_ARRAY = Uint8Array;
const DATA_VIEW = DataView;
const BUFFER_FROM = Buffer.from;
const BUFFER_PROTOTYPE = Buffer.prototype;
const DATA_VIEW_BUFFER = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer').get;
const DATA_VIEW_OFFSET = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset').get;
const DATA_VIEW_LENGTH = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength').get;

// What the checked copy becomes as text goes through the built-in prototypes of the values in it
// (Object.prototype for every object, Array.prototype, Map.prototype, Date.prototype...). A function
// that the tool, or anything else that ran before the check, added to one of them under one of
// these keys would run when the copy is serialized, converted, printed or iterated, and could
// produce text that was never checked. Their state when this module was loaded is kept, and a
// result is blocked when a prototype that its copy uses no longer matches it.
const PROTOTYPE_KEYS = ['toJSON', 'toString', 'valueOf', 'toISOString', 'then', 'entries', 'values', 'keys', 'get',
  Symbol.toPrimitive, Symbol.toStringTag, Symbol.iterator, util.inspect.custom];
function prototypeState(proto) {
  return PROTOTYPE_KEYS.map((key) => Object.getOwnPropertyDescriptor(proto, key));
}
const PROTOTYPE_BASELINE = new Map([...TRUSTED_PROTOTYPES].map((proto) => [proto, prototypeState(proto)]));

function sameDescriptor(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return a.value === b.value && a.get === b.get && a.set === b.set;
}

/** True when one of `protos` (built-in prototypes) has another value under a PROTOTYPE_KEYS key than at load. */
function prototypeModified(protos) {
  for (const proto of protos) {
    const baseline = PROTOTYPE_BASELINE.get(proto);
    if (baseline === undefined) return true; // not a built-in prototype: never expected in the copy
    const now = prototypeState(proto);
    for (let i = 0; i < now.length; i++) {
      if (!sameDescriptor(now[i], baseline[i])) return true;
    }
  }
  return false;
}

const MODIFIED_PROTOTYPE_REASON = 'a built-in prototype was modified (for example Object.prototype.toJSON), so the result '
  + 'could turn into text that was not checked';

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
 * `own` is null for a typed array, whose elements are bytes and numbers. `hooked` is true when a
 * function under a HOOK_KEYS key (own, or on a prototype other than a built-in one) decides how
 * `obj` serializes, converts or resolves. A typed array is kept as it is in the snapshot, so one
 * with such a hook is Unscannable instead.
 */
function screenObject(obj) {
  if (types.isProxy(obj)) throw new Unscannable();
  const typed = types.isTypedArray(obj);
  const container = typed || Array.isArray(obj) || types.isSet(obj) || types.isMap(obj);
  let own = null;
  let hooked = false;
  if (typed) {
    // Its elements cannot be accessors; listing every index of a large buffer would be slow.
    for (const key of [Symbol.iterator, ...HOOK_KEYS]) {
      if (Object.getOwnPropertyDescriptor(obj, key)) throw new Unscannable();
    }
  } else {
    own = Object.getOwnPropertyDescriptors(obj);
    for (const key of Reflect.ownKeys(own)) {
      const d = own[key];
      if ((d.get || d.set) && !isErrorStack(key, d)) throw new Unscannable();
      if (container && key === Symbol.iterator) throw new Unscannable();
      if (HOOK_KEYS.has(key) && typeof d.value === 'function') hooked = true;
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
      if (HOOK_KEYS.has(key) && typeof d.value === 'function') {
        if (typed) throw new Unscannable();
        hooked = true;
      }
    }
  }
  return { own, hooked };
}


/** The primitive inside a String, Number or Boolean object, read with the built-in valueOf. */
function unboxed(data) {
  if (types.isStringObject(data)) return STRING_VALUE.call(data);
  if (types.isNumberObject(data)) return NUMBER_VALUE.call(data);
  return BOOLEAN_VALUE.call(data);
}

/** The href of a URL made by the URL class, or undefined for any other object. */
function urlHref(data) {
  if (!(data instanceof URL_CLASS)) return undefined;
  try {
    return URL_HREF.call(data);
  } catch {
    return undefined; // URL.prototype in its chain, but not made by the URL class
  }
}

/** Records the prototypes `out` (an object of the copy) inherits from, for prototypeModified; returns `out`. */
function usesPrototypes(out, state) {
  for (let proto = Object.getPrototypeOf(out); proto !== null; proto = Object.getPrototypeOf(proto)) state.protos.add(proto);
  return out;
}

function inChain(obj, proto) {
  for (let p = Object.getPrototypeOf(obj); p !== null; p = Object.getPrototypeOf(p)) {
    if (p === proto) return true;
  }
  return false;
}

/** A fresh Uint8Array holding a copy of `length` bytes of `buffer` from `offset` (Unscannable when detached). */
function copiedBytes(buffer, offset, length) {
  try {
    return new UINT8_ARRAY(new UINT8_ARRAY(buffer, offset, length));
  } catch {
    throw new Unscannable();
  }
}

function utf8(bytes) {
  return BUFFER_FROM(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
}

/**
 * A copy of a typed array as a new array of the same built-in kind (a Buffer stays a Buffer):
 * its elements only, without the properties, hooks or class of the original.
 */
function typedCopy(data) {
  const Kind = TYPED_ARRAY_CLASSES.get(TYPED_ARRAY_TAG.call(data));
  if (Kind === undefined) throw new Unscannable();
  try {
    const copy = new Kind(data); // reads the elements through the internal slots, never through its code
    return inChain(data, BUFFER_PROTOTYPE) ? BUFFER_FROM(copy.buffer, 0, copy.byteLength) : copy;
  } catch {
    throw new Unscannable(); // a detached buffer
  }
}

/** The value of a data property `key`, own or inherited, when it is a string; '' otherwise. */
function textProperty(data, own, key) {
  let d = own[key];
  for (let proto = Object.getPrototypeOf(data); d === undefined && proto !== null; proto = Object.getPrototypeOf(proto)) {
    d = Object.getOwnPropertyDescriptor(proto, key);
  }
  return d !== undefined && 'value' in d && typeof d.value === 'string' ? d.value : '';
}

function defineData(out, key, value) {
  // defineProperty, so a key such as __proto__ stays an ordinary property
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Copies the listed (enumerable) string-keyed data values of `own` into `out`, functions left out. */
function copyListed(own, out, maxDepth, memo, state, skip) {
  for (const key of Reflect.ownKeys(own)) {
    const d = own[key];
    if (typeof key !== 'string' || !d.enumerable || !('value' in d) || (skip && skip.has(key))) continue;
    const value = snapshotOf(d.value, maxDepth - 1, memo, state);
    if (typeof d.value === 'function') continue;
    defineData(out, key, value);
  }
  return out;
}

const ERROR_FIELDS = new Set(['name', 'message', 'stack', 'cause', 'errors']);

/**
 * A copy of a tool result made of plain data, built without running any of its code, or
 * Unscannable (see screenObject). It is what the result check reads, what masking rebuilds, and
 * what guardTool returns with checkResult, so no way of turning the returned value into text can
 * show anything else than what was checked. Throws NestingTooDeep where extractStrings would. A
 * container that contains itself stays so in the copy.
 *
 * - Arrays, Sets and Maps become new containers of the same kind (read with the built-in iterators).
 * - Any other object becomes a plain object of its listed (enumerable) string-keyed values: its
 *   class, methods, symbol keys (Symbol.toStringTag included) and hooks are not copied.
 * - Functions are never data: a function property is left out, a function in an array becomes
 *   undefined, a Set or Map entry with one is left out, and a function result becomes undefined.
 * - An Error becomes a plain object { name, message, ...its listed values, cause?, errors? } (the
 *   cause and the errors of an AggregateError copied the same way); its stack is left out.
 * - A RegExp becomes its text, '/source/flags'. A String, Number or Boolean object becomes its
 *   primitive value. A Date becomes a new Date of the same time. A URL becomes a new URL of the same
 *   href (the href is checked: it is added to `state.texts`).
 * - A typed array or Buffer becomes a new one of the same built-in kind with the same elements; an
 *   ArrayBuffer or DataView a new one with the same bytes (checked as UTF-8 text, as a Buffer is).
 * - The description of a symbol is checked; the symbol itself is kept.
 *
 * The built-in prototypes the copy inherits from are added to `state.protos` (see prototypeModified).
 */
function snapshotOf(data, maxDepth, memo, state) {
  if (typeof data === 'function') return undefined;
  if (typeof data === 'symbol') {
    const description = SYMBOL_DESCRIPTION.call(data);
    if (description !== undefined) state.texts.push(description);
    return data;
  }
  if (typeof data === 'bigint') {
    state.protos.add(BigInt.prototype); // JSON.stringify looks up toJSON on it
    return data;
  }
  if (data === null || typeof data !== 'object') return data;
  if (memo.has(data)) return memo.get(data);
  const remember = (copy) => {
    memo.set(data, copy);
    return copy !== null && typeof copy === 'object' ? usesPrototypes(copy, state) : copy;
  };
  const { own } = screenObject(data);
  if (types.isTypedArray(data)) return remember(typedCopy(data));
  if (maxDepth <= 0) throw new NestingTooDeep();
  if (types.isStringObject(data) || types.isNumberObject(data) || types.isBooleanObject(data)) {
    return remember(unboxed(data));
  }
  if (types.isAnyArrayBuffer(data)) {
    const bytes = copiedBytes(data);
    state.texts.push(utf8(bytes));
    return remember(bytes.buffer);
  }
  if (types.isDataView(data)) {
    let view;
    try {
      view = [DATA_VIEW_BUFFER.call(data), DATA_VIEW_OFFSET.call(data), DATA_VIEW_LENGTH.call(data)];
    } catch {
      throw new Unscannable(); // a detached buffer
    }
    const bytes = copiedBytes(...view);
    state.texts.push(utf8(bytes));
    return remember(new DATA_VIEW(bytes.buffer));
  }
  if (types.isDate(data)) return remember(new DATE_CLASS(DATE_TIME.call(data)));
  const href = urlHref(data);
  if (href !== undefined) {
    state.texts.push(href);
    return remember(new URL_CLASS(href));
  }
  if (types.isRegExp(data)) return remember(`/${REGEXP_SOURCE.call(data)}/${REGEXP_FLAGS.call(data)}`);
  if (types.isNativeError(data)) {
    const out = remember({});
    defineData(out, 'name', textProperty(data, own, 'name'));
    defineData(out, 'message', textProperty(data, own, 'message'));
    copyListed(own, out, maxDepth, memo, state, ERROR_FIELDS);
    for (const key of ['cause', 'errors']) {
      const d = own[key];
      if (d === undefined || !('value' in d) || typeof d.value === 'function') continue;
      defineData(out, key, snapshotOf(d.value, maxDepth - 1, memo, state));
    }
    return out;
  }
  if (Array.isArray(data)) {
    const out = remember(new Array(own.length.value));
    for (const key of Reflect.ownKeys(own)) {
      if (isIndexKey(key)) out[Number(key)] = snapshotOf(own[key].value, maxDepth - 1, memo, state);
    }
    return out;
  }
  if (types.isSet(data)) {
    const out = remember(new Set());
    for (const v of SET_VALUES.call(data)) {
      if (typeof v === 'function') continue;
      out.add(snapshotOf(v, maxDepth - 1, memo, state));
    }
    return out;
  }
  if (types.isMap(data)) {
    const out = remember(new Map());
    for (const entry of MAP_ENTRIES.call(data)) {
      if (typeof entry[0] === 'function' || typeof entry[1] === 'function') continue;
      out.set(snapshotOf(entry[0], maxDepth - 1, memo, state), snapshotOf(entry[1], maxDepth - 1, memo, state));
    }
    return out;
  }
  return copyListed(own, remember({}), maxDepth, memo, state, null);
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
 * `snapshot` (see snapshotOf), and a value that cannot be read without running its code is a
 * block too, as is a copy that inherits from a built-in prototype modified since this module
 * was loaded (see prototypeModified).
 */
function stringsOrBlock(data, what, snapshot = false) {
  try {
    if (!snapshot) return { strings: extractStrings(data, MAX_DEPTH, new WeakSet(), []) };
    const state = { texts: [], protos: new Set() };
    const copy = snapshotOf(data, MAX_DEPTH, new Map(), state);
    if (prototypeModified(state.protos)) throw new Unscannable(MODIFIED_PROTOTYPE_REASON);
    const strings = extractStrings(copy, MAX_DEPTH, new WeakSet(), []);
    for (const text of state.texts) strings.push(text);
    return { strings, snapshot: copy };
  } catch (e) {
    if (e instanceof Unscannable) {
      return {
        block: {
          allowed: false, verdict: 'block', confidence: 1.0, rule: 'type:unscannable',
          reason: `${what}: ${e.message || HIDDEN_ACCESSORS_REASON}`,
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
 * is blocked (rule type:unscannable, see screenObject), as in the Python package,
 * and so is one whose copy inherits from a modified built-in prototype (see prototypeModified).
 * Internal helper of guardTool; the public async variant is checkToolResult in lib/client.js.
 */
function scanToolResult(result, opts = {}) {
  return checkResultSnapshot(result, opts).assessment;
}

/**
 * scanToolResult, plus the plain-data copy it checked (see snapshotOf) when the result is allowed.
 */
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
 *   checkResult     check the return value (default false); the wrapper then returns the plain-data
 *                   copy that was checked (see snapshotOf), not class instances, functions or hooks
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
    let out = res;
    if (opts.checkResult) {
      const { assessment, snapshot } = checkResultSnapshot(res, { ...engineOpts, blockTruncated: opts.blockTruncated === true, allowTruncated: opts.allowTruncated === true });
      if (!assessment.allowed) return blocked(assessment, name + ':result', res).value;
      // Always the copy that was checked (plain data, see snapshotOf), never the result itself:
      // whatever turns it into text (JSON.stringify, String(), util.inspect, a template literal)
      // can only show what was checked. A primitive is its own copy. Masking rebuilds that copy.
      out = snapshot;
    }
    return opts.maskSecrets ? sanitizeToolResult(out).sanitized : out;
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
        // A thenable is settled as a real promise, so whatever it resolves to goes through after():
        // its own then() could return anything.
        if (res && typeof res.then === 'function') return PROMISE_THEN.call(Promise.resolve(res), after);
        return after(res);
      };
  Object.defineProperty(wrapped, 'name', { value: fn.name, configurable: true });
  return wrapped;
}

module.exports = { checkToolCall, guardTool, GuardBlockError, blockMessage, extractStrings, scanToolResult, ON_BLOCK_VALUES };
