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

// Built-in functions taken when this module is loaded. The result check calls only these (through
// Reflect.apply), never a method looked up on a live object or prototype, so a built-in replaced
// later (Set.prototype.add, Map.prototype.get, Array.prototype.push, Object.getOwnPropertyDescriptors,
// a typed array getter, Buffer.prototype.toString...) cannot change what is copied or read.
const ReflectApply = Reflect.apply;
const ReflectOwnKeys = Reflect.ownKeys;
const ReflectGet = Reflect.get;
const ObjectGetPrototypeOf = Object.getPrototypeOf;
const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const ObjectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const ObjectDefineProperty = Object.defineProperty;
const ObjectHasOwn = Object.hasOwn;
const ArrayIsArray = Array.isArray;
const ARRAY_CLASS = Array;
const SET_CLASS = Set;
const MAP_CLASS = Map;
const WEAK_SET_CLASS = WeakSet;
const NUMBER_CLASS = Number;
const STRING_CLASS = String;
const SYMBOL_ITERATOR = Symbol.iterator;
const ARRAY_PUSH = Array.prototype.push;
const SET_HAS = Set.prototype.has;
const SET_ADD = Set.prototype.add;
const SET_VALUES = Set.prototype.values;
const MAP_HAS = Map.prototype.has;
const MAP_GET = Map.prototype.get;
const MAP_SET = Map.prototype.set;
const MAP_ENTRIES = Map.prototype.entries;
const WEAK_SET_HAS = WeakSet.prototype.has;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_DELETE = WeakSet.prototype.delete;
const ARRAY_ITERATOR_PROTOTYPE = Object.getPrototypeOf([][Symbol.iterator]());
const ITERATOR_PROTOTYPE = Object.getPrototypeOf(ARRAY_ITERATOR_PROTOTYPE);
const SET_ITERATOR_PROTOTYPE = Object.getPrototypeOf(new Set().values());
const MAP_ITERATOR_PROTOTYPE = Object.getPrototypeOf(new Map().entries());
const STRING_ITERATOR_PROTOTYPE = Object.getPrototypeOf(''[Symbol.iterator]());
const REGEXP_STRING_ITERATOR_PROTOTYPE = Object.getPrototypeOf(/a/g[Symbol.matchAll](''));
const SET_ITERATOR_NEXT = SET_ITERATOR_PROTOTYPE.next;
const MAP_ITERATOR_NEXT = MAP_ITERATOR_PROTOTYPE.next;
const {
  isProxy, isTypedArray, isSet, isMap, isUint8Array, isStringObject, isNumberObject, isBooleanObject,
  isAnyArrayBuffer, isSharedArrayBuffer, isDataView, isDate, isRegExp, isNativeError,
} = types;

const setHas = (set, value) => ReflectApply(SET_HAS, set, [value]);
const setAdd = (set, value) => ReflectApply(SET_ADD, set, [value]);
const mapHas = (map, key) => ReflectApply(MAP_HAS, map, [key]);
const mapGet = (map, key) => ReflectApply(MAP_GET, map, [key]);
const mapSet = (map, key, value) => ReflectApply(MAP_SET, map, [key, value]);
const push = (list, value) => ReflectApply(ARRAY_PUSH, list, [value]);

/** Calls `visit` on each value of a Set, or each [key, value] entry of a Map, through the built-in iterator. */
function eachOf(collection, visit) {
  const map = isMap(collection);
  const it = ReflectApply(map ? MAP_ENTRIES : SET_VALUES, collection, []);
  const next = map ? MAP_ITERATOR_NEXT : SET_ITERATOR_NEXT;
  for (let step = ReflectApply(next, it, []); !step.done; step = ReflectApply(next, it, [])) visit(step.value);
}

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
// Keys through which an object decides what it becomes when it is serialized (JSON.stringify),
// converted to text or a number, printed, or awaited. A function stored under one of them runs
// after the check, so it could produce text that was never checked.
const HOOK_KEYS = new Set(['toJSON', 'toString', 'valueOf', 'toISOString', 'then', Symbol.toPrimitive, util.inspect.custom]);
const TYPED_ARRAY_OWN_KEYS = [Symbol.iterator, ...HOOK_KEYS];
// Built-in readers, called on objects whose class is known so that no code of the result runs.
const URL_CLASS = URL;
const URL_PROTOTYPE = URL.prototype;
const URL_HREF = Object.getOwnPropertyDescriptor(URL.prototype, 'href').get;
const PROMISE_THEN = Promise.prototype.then;
const PROMISE_RESOLVE = Promise.resolve;
const PROMISE_CLASS = Promise;
const STRING_VALUE = String.prototype.valueOf;
const NUMBER_VALUE = Number.prototype.valueOf;
const BOOLEAN_VALUE = Boolean.prototype.valueOf;
const DATE_CLASS = Date;
const DATE_TIME = Date.prototype.getTime;
const REGEXP_SOURCE = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get;
const REGEXP_FLAGS = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags').get;
const SYMBOL_DESCRIPTION = Object.getOwnPropertyDescriptor(Symbol.prototype, 'description').get;
const TYPED_ARRAY_TAG = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag).get;
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'buffer').get;
const TYPED_ARRAY_LENGTH = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'byteLength').get;
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
// UTF-8 text of bytes, as Buffer#toString('utf8') gives it (a leading BOM kept, invalid bytes replaced).
const UTF8_DECODER = new TextDecoder('utf-8', { ignoreBOM: true });
const TEXT_DECODE = TextDecoder.prototype.decode;

// What the checked copy becomes as text goes through the built-in prototypes of the values in it
// (Object.prototype for every object, Array.prototype, Map.prototype, Date.prototype...), and the
// rules read the text through String.prototype, RegExp.prototype, the built-in iterators and the
// Object, Array, String, Number, JSON and Reflect functions. A function that the tool, or anything
// else that ran before the check, put there would run when the copy is serialized, converted,
// printed or iterated, or when the rules read it, and could produce or hide text that was never
// checked. Their state when this module was loaded is kept, and a result is blocked when one of
// them changed: a function (method, getter or setter) replaced, added or removed, a value under a
// PROTOTYPE_KEYS key changed or added, or an index key added (an array hole reads it). Other new
// keys (a polyfill adding a method that did not exist) and other values (Buffer.poolSize) are ignored.
const PROTOTYPE_KEYS = new Set(['toJSON', 'toString', 'valueOf', 'toISOString', 'then', 'entries', 'values', 'keys',
  'get', 'set', 'add', 'has', 'delete', 'forEach', 'next', 'value', 'enumerable', 'writable', 'configurable',
  Symbol.toPrimitive, Symbol.toStringTag, Symbol.iterator, Symbol.hasInstance, util.inspect.custom]);
// Always checked, before the copy is made: the check and every copy use them.
const CHECK_INTRINSICS = [Object.prototype, Function.prototype, Array.prototype, String.prototype, RegExp.prototype,
  ITERATOR_PROTOTYPE, ARRAY_ITERATOR_PROTOTYPE, STRING_ITERATOR_PROTOTYPE, REGEXP_STRING_ITERATOR_PROTOTYPE,
  Object, Array, String, Number, JSON, Reflect];
// Always checked too, for their existing methods only (the rules use them); a key added to one of
// them (Set.prototype.toJSON) only matters to a copy that holds such a value (prototypeModified).
const CHECK_METHODS = [Set.prototype, Map.prototype, WeakSet.prototype, WeakMap.prototype, SET_ITERATOR_PROTOTYPE,
  MAP_ITERATOR_PROTOTYPE];
// Global bindings that the rules and the caller's serialization look up by name.
const CHECK_GLOBALS = ['Object', 'Array', 'String', 'Number', 'JSON', 'Reflect', 'Map', 'Set', 'RegExp', 'Symbol'];

function holderState(holder) {
  const state = new MAP_CLASS();
  const keys = ReflectOwnKeys(holder);
  for (let i = 0; i < keys.length; i++) mapSet(state, keys[i], ObjectGetOwnPropertyDescriptor(holder, keys[i]));
  return state;
}
const PROTOTYPE_BASELINE = new Map();
for (const holder of [...TRUSTED_PROTOTYPES, ...CHECK_INTRINSICS, ...CHECK_METHODS]) {
  PROTOTYPE_BASELINE.set(holder, holderState(holder));
}
const GLOBAL_BASELINE = CHECK_GLOBALS.map((name) => [name, globalThis[name]]);

/** False when `now` and `before` (own property descriptors, or undefined) differ in a way that can change text. */
function sameDescriptor(now, before, strict) {
  if (now === undefined || before === undefined) return now === before;
  const isData = ObjectHasOwn(now, 'value');
  if (isData !== ObjectHasOwn(before, 'value')) return false;
  if (!isData) return now.get === before.get && now.set === before.set;
  if (strict || typeof now.value === 'function' || typeof before.value === 'function') return now.value === before.value;
  return true; // another number or string (Buffer.poolSize...): configuration, not code
}

/**
 * True when `holder` (a built-in prototype or namespace) changed since this module was loaded (see
 * above); with `existingOnly`, keys added since then are not counted.
 */
function holderModified(holder, existingOnly = false) {
  const baseline = mapGet(PROTOTYPE_BASELINE, holder);
  if (baseline === undefined) return true; // not a built-in prototype: never expected in the copy
  const keys = ReflectOwnKeys(holder);
  let seen = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const tracked = setHas(PROTOTYPE_KEYS, key);
    if (!mapHas(baseline, key)) {
      if (!existingOnly && (tracked || isIndexKey(key))) return true;
      continue;
    }
    seen++;
    if (!sameDescriptor(ObjectGetOwnPropertyDescriptor(holder, key), mapGet(baseline, key), tracked)) return true;
  }
  return seen !== baseline.size; // a built-in key was removed
}

/** True when a built-in the check relies on (CHECK_INTRINSICS, CHECK_METHODS, CHECK_GLOBALS) changed since load. */
function intrinsicsModified() {
  for (let i = 0; i < CHECK_INTRINSICS.length; i++) {
    if (holderModified(CHECK_INTRINSICS[i])) return true;
  }
  for (let i = 0; i < CHECK_METHODS.length; i++) {
    if (holderModified(CHECK_METHODS[i], true)) return true;
  }
  for (let i = 0; i < GLOBAL_BASELINE.length; i++) {
    const d = ObjectGetOwnPropertyDescriptor(globalThis, GLOBAL_BASELINE[i][0]);
    if (d === undefined || !ObjectHasOwn(d, 'value') || d.value !== GLOBAL_BASELINE[i][1]) return true;
  }
  return false;
}

/** True when one of `protos` (a Set of the built-in prototypes the copy uses) changed since load (see holderModified). */
function prototypeModified(protos) {
  let modified = false;
  eachOf(protos, (proto) => { if (!modified && holderModified(proto)) modified = true; });
  return modified;
}

const MODIFIED_PROTOTYPE_REASON = 'a built-in prototype was modified (for example Object.prototype.toJSON), so the result '
  + 'could turn into text that was not checked';
const MODIFIED_ARGUMENTS_REASON = 'a built-in prototype or function was modified (for example Object.entries or '
  + 'String.prototype.toLowerCase), so the arguments could hold text that the check would not see';

function isErrorStack(key, d) {
  return key === 'stack' && ERROR_STACK !== undefined && ERROR_STACK.get !== undefined
    && d.get === ERROR_STACK.get && d.set === ERROR_STACK.set;
}

function isIndexKey(key) {
  return typeof key === 'string' && key !== '4294967295' && STRING_CLASS(NUMBER_CLASS(key) >>> 0) === key;
}

/** The own descriptor `key` of `descriptors` (from getOwnPropertyDescriptors), never one inherited from Object.prototype. */
function ownDescriptor(descriptors, key) {
  return ObjectHasOwn(descriptors, key) ? descriptors[key] : undefined;
}

function isAccessor(d) {
  return !ObjectHasOwn(d, 'value');
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
  if (isProxy(obj)) throw new Unscannable();
  const typed = isTypedArray(obj);
  const container = typed || ArrayIsArray(obj) || isSet(obj) || isMap(obj);
  let own = null;
  let hooked = false;
  if (typed) {
    // Its elements cannot be accessors; listing every index of a large buffer would be slow.
    for (let i = 0; i < TYPED_ARRAY_OWN_KEYS.length; i++) {
      if (ObjectGetOwnPropertyDescriptor(obj, TYPED_ARRAY_OWN_KEYS[i])) throw new Unscannable();
    }
  } else {
    own = ObjectGetOwnPropertyDescriptors(obj);
    const keys = ReflectOwnKeys(own);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const d = own[key];
      if (isAccessor(d) && !isErrorStack(key, d)) throw new Unscannable();
      if (container && key === SYMBOL_ITERATOR) throw new Unscannable();
      if (setHas(HOOK_KEYS, key) && typeof d.value === 'function') hooked = true;
    }
  }
  for (let proto = ObjectGetPrototypeOf(obj); proto !== null; proto = ObjectGetPrototypeOf(proto)) {
    if (isProxy(proto)) throw new Unscannable();
    if (setHas(TRUSTED_PROTOTYPES, proto)) continue;
    const inherited = ObjectGetOwnPropertyDescriptors(proto);
    const keys = ReflectOwnKeys(inherited);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const d = inherited[key];
      if (isAccessor(d)) throw new Unscannable();
      if (container && key === SYMBOL_ITERATOR) throw new Unscannable();
      if (setHas(HOOK_KEYS, key) && typeof d.value === 'function') {
        if (typed) throw new Unscannable();
        hooked = true;
      }
    }
  }
  return { own, hooked };
}


/** The primitive inside a String, Number or Boolean object, read with the built-in valueOf. */
function unboxed(data) {
  if (isStringObject(data)) return ReflectApply(STRING_VALUE, data, []);
  if (isNumberObject(data)) return ReflectApply(NUMBER_VALUE, data, []);
  return ReflectApply(BOOLEAN_VALUE, data, []);
}

/** The href of a URL made by the URL class, or undefined for any other object. */
function urlHref(data) {
  if (!inChain(data, URL_PROTOTYPE)) return undefined;
  try {
    return ReflectApply(URL_HREF, data, []);
  } catch {
    return undefined; // URL.prototype in its chain, but not made by the URL class
  }
}

/** Records the prototypes `out` (an object of the copy) inherits from, for prototypeModified; returns `out`. */
function usesPrototypes(out, state) {
  for (let proto = ObjectGetPrototypeOf(out); proto !== null; proto = ObjectGetPrototypeOf(proto)) setAdd(state.protos, proto);
  return out;
}

function inChain(obj, proto) {
  for (let p = ObjectGetPrototypeOf(obj); p !== null; p = ObjectGetPrototypeOf(p)) {
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

/** A fresh Uint8Array holding a copy of the bytes a DataView shows (Unscannable when detached). */
function dataViewBytes(view) {
  try {
    return copiedBytes(ReflectApply(DATA_VIEW_BUFFER, view, []), ReflectApply(DATA_VIEW_OFFSET, view, []),
      ReflectApply(DATA_VIEW_LENGTH, view, []));
  } catch {
    throw new Unscannable(); // a detached buffer
  }
}

/** The UTF-8 text of a Uint8Array (or Buffer), decoded by the decoder taken at load. */
function utf8(bytes) {
  // The decoder refuses a view of shared memory: it reads a private copy of those bytes instead.
  const view = isSharedArrayBuffer(ReflectApply(TYPED_ARRAY_BUFFER, bytes, [])) ? new UINT8_ARRAY(bytes) : bytes;
  return ReflectApply(TEXT_DECODE, UTF8_DECODER, [view]);
}

/**
 * A copy of a typed array as a new array of the same built-in kind (a Buffer stays a Buffer):
 * its elements only, without the properties, hooks or class of the original.
 */
function typedCopy(data) {
  const Kind = mapGet(TYPED_ARRAY_CLASSES, ReflectApply(TYPED_ARRAY_TAG, data, []));
  if (Kind === undefined) throw new Unscannable();
  try {
    const copy = new Kind(data); // reads the elements through the internal slots, never through its code
    if (!inChain(data, BUFFER_PROTOTYPE)) return copy;
    return BUFFER_FROM(ReflectApply(TYPED_ARRAY_BUFFER, copy, []), 0, ReflectApply(TYPED_ARRAY_LENGTH, copy, []));
  } catch {
    throw new Unscannable(); // a detached buffer
  }
}

/** The value of a data property `key`, own or inherited, when it is a string; '' otherwise. */
function textProperty(data, own, key) {
  let d = ownDescriptor(own, key);
  for (let proto = ObjectGetPrototypeOf(data); d === undefined && proto !== null; proto = ObjectGetPrototypeOf(proto)) {
    d = ObjectGetOwnPropertyDescriptor(proto, key);
  }
  return d !== undefined && !isAccessor(d) && typeof d.value === 'string' ? d.value : '';
}

function defineData(out, key, value) {
  // defineProperty, so a key such as __proto__ stays an ordinary property and no setter of a
  // prototype runs; a descriptor without a prototype, so none of its fields is inherited.
  ObjectDefineProperty(out, key, { __proto__: null, value, enumerable: true, writable: true, configurable: true });
}

/** Copies the listed (enumerable) string-keyed data values of `own` into `out`, functions left out. */
function copyListed(own, out, maxDepth, memo, state, skip) {
  const keys = ReflectOwnKeys(own);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const d = own[key];
    if (typeof key !== 'string' || !d.enumerable || isAccessor(d) || (skip && setHas(skip, key))) continue;
    const value = snapshotOf(d.value, maxDepth - 1, memo, state);
    if (typeof d.value === 'function') continue;
    defineData(out, key, value);
  }
  return out;
}

const ERROR_FIELDS = new Set(['name', 'message', 'stack', 'cause', 'errors']);
const ERROR_LINKS = ['cause', 'errors'];
const BIGINT_PROTOTYPE = BigInt.prototype;

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
    const description = ReflectApply(SYMBOL_DESCRIPTION, data, []);
    if (description !== undefined) push(state.texts, description);
    return data;
  }
  if (typeof data === 'bigint') {
    setAdd(state.protos, BIGINT_PROTOTYPE); // JSON.stringify looks up toJSON on it
    return data;
  }
  if (data === null || typeof data !== 'object') return data;
  if (mapHas(memo, data)) return mapGet(memo, data);
  const remember = (copy) => {
    mapSet(memo, data, copy);
    return copy !== null && typeof copy === 'object' ? usesPrototypes(copy, state) : copy;
  };
  const { own } = screenObject(data);
  if (isTypedArray(data)) return remember(typedCopy(data));
  if (maxDepth <= 0) throw new NestingTooDeep();
  if (isStringObject(data) || isNumberObject(data) || isBooleanObject(data)) {
    return remember(unboxed(data));
  }
  if (isAnyArrayBuffer(data)) {
    const bytes = copiedBytes(data);
    push(state.texts, utf8(bytes));
    return remember(ReflectApply(TYPED_ARRAY_BUFFER, bytes, []));
  }
  if (isDataView(data)) {
    const bytes = dataViewBytes(data);
    push(state.texts, utf8(bytes));
    return remember(new DATA_VIEW(ReflectApply(TYPED_ARRAY_BUFFER, bytes, [])));
  }
  if (isDate(data)) return remember(new DATE_CLASS(ReflectApply(DATE_TIME, data, [])));
  const href = urlHref(data);
  if (href !== undefined) {
    push(state.texts, href);
    return remember(new URL_CLASS(href));
  }
  if (isRegExp(data)) {
    return remember(`/${ReflectApply(REGEXP_SOURCE, data, [])}/${ReflectApply(REGEXP_FLAGS, data, [])}`);
  }
  if (isNativeError(data)) {
    const out = remember({});
    defineData(out, 'name', textProperty(data, own, 'name'));
    defineData(out, 'message', textProperty(data, own, 'message'));
    copyListed(own, out, maxDepth, memo, state, ERROR_FIELDS);
    for (let i = 0; i < ERROR_LINKS.length; i++) {
      const d = ownDescriptor(own, ERROR_LINKS[i]);
      if (d === undefined || isAccessor(d) || typeof d.value === 'function') continue;
      defineData(out, ERROR_LINKS[i], snapshotOf(d.value, maxDepth - 1, memo, state));
    }
    return out;
  }
  if (ArrayIsArray(data)) {
    const out = remember(new ARRAY_CLASS(own.length.value));
    const keys = ReflectOwnKeys(own);
    for (let i = 0; i < keys.length; i++) {
      if (isIndexKey(keys[i])) defineData(out, keys[i], snapshotOf(own[keys[i]].value, maxDepth - 1, memo, state));
    }
    return out;
  }
  if (isSet(data)) {
    const out = remember(new SET_CLASS());
    setAdd(state.protos, SET_ITERATOR_PROTOTYPE); // what iterates the copy
    eachOf(data, (v) => {
      if (typeof v !== 'function') setAdd(out, snapshotOf(v, maxDepth - 1, memo, state));
    });
    return out;
  }
  if (isMap(data)) {
    const out = remember(new MAP_CLASS());
    setAdd(state.protos, MAP_ITERATOR_PROTOTYPE);
    eachOf(data, (entry) => {
      if (typeof entry[0] === 'function' || typeof entry[1] === 'function') return;
      mapSet(out, snapshotOf(entry[0], maxDepth - 1, memo, state), snapshotOf(entry[1], maxDepth - 1, memo, state));
    });
    return out;
  }
  return copyListed(own, remember({}), maxDepth, memo, state, null);
}

/**
 * Every string in a copy made by snapshotOf, as extractStrings would list them, read with the
 * built-in functions taken at load: own data properties, the built-in Set and Map iterators, and
 * the UTF-8 decoder. Throws NestingTooDeep where extractStrings would.
 */
function copyStrings(data, maxDepth, path, out) {
  if (typeof data === 'string') { push(out, data); return out; }
  if (data === null || typeof data !== 'object') return out;
  if (isTypedArray(data)) {
    if (isUint8Array(data)) push(out, utf8(data)); // other kinds hold numbers only
    return out;
  }
  if (maxDepth <= 0) throw new NestingTooDeep();
  if (ReflectApply(WEAK_SET_HAS, path, [data])) return out;
  ReflectApply(WEAK_SET_ADD, path, [data]);
  try {
    const visit = (child) => { copyStrings(child, maxDepth - 1, path, out); };
    if (isSet(data)) {
      eachOf(data, visit);
    } else if (isMap(data)) {
      eachOf(data, (entry) => { visit(entry[0]); visit(entry[1]); });
    } else {
      // An array lists its index keys (its holes hold nothing), any other object its listed keys.
      const array = ArrayIsArray(data);
      const keys = ReflectOwnKeys(data);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (typeof key !== 'string' || (array && !isIndexKey(key))) continue;
        const d = ObjectGetOwnPropertyDescriptor(data, key);
        if (!d.enumerable || isAccessor(d)) continue;
        if (!array) push(out, key);
        visit(d.value);
      }
    }
    return out;
  } finally {
    ReflectApply(WEAK_SET_DELETE, path, [data]);
  }
}

const HIDDEN_ACCESSORS_REASON = 'An object shows values through getters, setters or a Proxy that cannot be checked '
  + 'without running its code; return its data as a plain object instead';

/**
 * Calls `visit(key, value)` for each listed (enumerable) string-keyed own property of `data`, in the
 * order Object.entries lists them and read as it reads them (a getter or a Proxy trap runs), through
 * the built-in functions taken at load. With `skipIndex`, index keys are left out.
 */
function eachListed(data, skipIndex, visit) {
  const keys = ReflectOwnKeys(data);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (typeof key !== 'string' || (skipIndex && isIndexKey(key))) continue;
    const d = ObjectGetOwnPropertyDescriptor(data, key);
    if (d !== undefined && d.enumerable) visit(key, ReflectGet(data, key));
  }
}

/** The text an object holds in its internal slots (bytes as UTF-8, a String object), or undefined. */
function slotText(data) {
  if (isUint8Array(data)) return utf8(data);
  if (isStringObject(data)) return ReflectApply(STRING_VALUE, data, []);
  if (isAnyArrayBuffer(data)) return utf8(copiedBytes(data));
  if (isDataView(data)) return utf8(dataViewBytes(data));
  return undefined;
}

const SET_PROTOTYPE = Set.prototype;
const MAP_PROTOTYPE = Map.prototype;

/**
 * Every string in a nested structure, object keys included. Walks arrays (their elements, then their
 * other listed keys), sets, maps (keys and values) and other objects (their listed string keys and
 * values, as Object.entries lists them), and decodes a Buffer, Uint8Array, ArrayBuffer or DataView as
 * UTF-8 (a String object is its text). It reads only through the built-in functions taken when this
 * module was loaded, never through an iterator or a method of the value or of a built-in prototype,
 * so neither the value nor a built-in replaced later decides what is listed. Throws NestingTooDeep
 * instead of skipping content below the depth limit, so callers can fail closed, and Unscannable for
 * a Proxy of a Set or a Map (whose content cannot be listed without running its code). A container
 * that contains itself is walked once.
 */
function extractStrings(data, maxDepth = MAX_DEPTH, path = new WEAK_SET_CLASS(), out = []) {
  if (typeof data === 'string') { push(out, data); return out; }
  if (data === null || typeof data !== 'object') return out;
  const text = slotText(data);
  if (text !== undefined) push(out, text);
  // A typed array holds bytes or numbers only; listing its keys would list every element.
  if (isTypedArray(data)) return out;
  const array = ArrayIsArray(data);
  // Index keys of an array or a String object are its elements, listed once.
  const skipIndex = array || text !== undefined;
  if (maxDepth <= 0) {
    // Bytes and text are read whole at any depth; anything they or a container hold is not.
    if (text === undefined) throw new NestingTooDeep();
    eachListed(data, skipIndex, () => { throw new NestingTooDeep(); });
    return out;
  }
  if (ReflectApply(WEAK_SET_HAS, path, [data])) return out;
  ReflectApply(WEAK_SET_ADD, path, [data]);
  try {
    const visit = (child) => { extractStrings(child, maxDepth - 1, path, out); };
    if (array) {
      // By index up to the length, as the built-in array iterator reads it: never through an
      // iterator of the array itself, which could list other values than the tool reads.
      const length = ReflectGet(data, 'length');
      if (typeof length !== 'number') throw new Unscannable();
      for (let i = 0; i < length; i++) visit(ReflectGet(data, i));
    } else if (isSet(data)) {
      eachOf(data, visit);
    } else if (isMap(data)) {
      eachOf(data, (entry) => { visit(entry[0]); visit(entry[1]); });
    } else if (isProxy(data) && (inChain(data, SET_PROTOTYPE) || inChain(data, MAP_PROTOTYPE))) {
      throw new Unscannable();
    }
    eachListed(data, skipIndex, (key, value) => { visit(key); visit(value); });
    return out;
  } finally {
    ReflectApply(WEAK_SET_DELETE, path, [data]);
  }
}

/**
 * extractStrings, or a block assessment when the payload is nested too deeply to check, or when a
 * built-in the check relies on was modified since this module was loaded (intrinsicsModified): before
 * the strings are read, and for arguments again after (a getter or a Proxy trap of the arguments runs
 * while they are read, and the rules read the strings through those built-ins).
 * With snapshot (tool results), the strings are read from snapshotOf(data), returned as
 * `snapshot` (see snapshotOf), and a value that cannot be read without running its code is a
 * block too, as is a check run while a built-in it relies on was modified since this module was
 * loaded (intrinsicsModified, before the copy is made) or a copy that inherits from a modified
 * built-in prototype (prototypeModified).
 */
function stringsOrBlock(data, what, snapshot = false) {
  try {
    if (!snapshot) {
      if (intrinsicsModified()) throw new Unscannable(MODIFIED_ARGUMENTS_REASON);
      const strings = extractStrings(data, MAX_DEPTH, new WEAK_SET_CLASS(), []);
      if (intrinsicsModified()) throw new Unscannable(MODIFIED_ARGUMENTS_REASON);
      return { strings };
    }
    if (intrinsicsModified()) throw new Unscannable(MODIFIED_PROTOTYPE_REASON);
    const state = { texts: [], protos: new SET_CLASS() };
    const copy = snapshotOf(data, MAX_DEPTH, new MAP_CLASS(), state);
    if (prototypeModified(state.protos)) throw new Unscannable(MODIFIED_PROTOTYPE_REASON);
    const strings = copyStrings(copy, MAX_DEPTH, new WEAK_SET_CLASS(), []);
    for (let i = 0; i < state.texts.length; i++) push(strings, state.texts[i]);
    return { strings, snapshot: copy };
  } catch (e) {
    if (e instanceof Unscannable) return { block: unscannableBlock(what, e.message || HIDDEN_ACCESSORS_REASON) };
    if (!(e instanceof NestingTooDeep)) throw e;
    return {
      block: {
        allowed: false, verdict: 'block', confidence: 1.0, rule: 'size:nesting',
        reason: `${what} nested too deeply to check`,
      },
    };
  }
}

function unscannableBlock(what, why) {
  return { allowed: false, verdict: 'block', confidence: 1.0, rule: 'type:unscannable', reason: `${what}: ${why}` };
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
  for (let i = 0; i < strings.length; i++) {
    const res = evaluate(strings[i], opts);
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
  for (let i = 0; i < strings.length; i++) {
    const res = scanWindows(strings[i], opts);
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
    if (!opts.maskSecrets) return out;
    // Masking walks the value with Object.entries and Array.prototype.map: a replaced one could
    // keep a credential out of the walk, so the value is not returned unmasked.
    if (intrinsicsModified()) return blocked(unscannableBlock('Result', MODIFIED_PROTOTYPE_REASON), name + ':result', res).value;
    return sanitizeToolResult(out).sanitized;
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
        if (res && typeof res.then === 'function') {
          return ReflectApply(PROMISE_THEN, ReflectApply(PROMISE_RESOLVE, PROMISE_CLASS, [res]), [after]);
        }
        return after(res);
      };
  Object.defineProperty(wrapped, 'name', { value: fn.name, configurable: true });
  return wrapped;
}

module.exports = { checkToolCall, guardTool, GuardBlockError, blockMessage, extractStrings, scanToolResult, ON_BLOCK_VALUES };
