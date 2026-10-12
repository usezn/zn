'use strict';
/**
 * A small JSON Schema validator for the subset used by the zn Team tool
 * input schemas (tools.json): type, properties, required,
 * additionalProperties:false, enum, const, pattern, min/maxLength,
 * minimum/maximum, min/maxItems, uniqueItems, items, oneOf, default and the
 * formats email, uuid and date-time.
 *
 * validate(schema, value) -> {ok:true, value} with defaults applied, or
 * {ok:false, errors:[string]} (at most 5 errors, paths like ops[1].hosts).
 */

const EMAIL_RE = /^[^\s@"'<>()[\]\\,;:]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(want, v) {
  const t = typeOf(v);
  if (want === 'number') return t === 'number' || t === 'integer';
  return t === want;
}

function check(schema, value, at, errors) {
  if (errors.length >= 5) return value;
  const where = at || 'arguments';
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(where + ' must be ' + JSON.stringify(schema.const));
    return value;
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(where + ' must be one of ' + schema.enum.map((e) => JSON.stringify(e)).join(', '));
    return value;
  }
  if (schema.oneOf) {
    let match = null;
    let n = 0;
    let firstErrors = null;
    // A discriminating `op` (or any const property) picks the branch, so the
    // error names what is wrong in it rather than "no branch matched".
    for (const branch of schema.oneOf) {
      const e = [];
      const v = check(branch, clone(value), at, e);
      if (e.length === 0) { n++; match = v; } else if (!firstErrors && discriminates(branch, value)) firstErrors = e;
    }
    if (n === 1) return match;
    if (firstErrors) errors.push(...firstErrors.slice(0, 5 - errors.length));
    else errors.push(where + (n > 1 ? ' matches more than one form' : ' is not a valid operation'));
    return value;
  }
  if (schema.type && !typeMatches(schema.type, value)) {
    errors.push(where + ' must be ' + (schema.type === 'integer' ? 'an integer' : schema.type === 'array' ? 'an array' : schema.type === 'object' ? 'an object' : 'a ' + schema.type));
    return value;
  }
  const t = typeOf(value);
  if (t === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(where + ' is too short');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(where + ' is too long (max ' + schema.maxLength + ')');
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(where + ' has an invalid format');
    if (schema.format === 'email' && !EMAIL_RE.test(value)) errors.push(where + ' must be an email address');
    if (schema.format === 'uuid' && !UUID_RE.test(value)) errors.push(where + ' must be a UUID');
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(where + ' must be a date-time');
  } else if (t === 'integer' || t === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(where + ' must be >= ' + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(where + ' must be <= ' + schema.maximum);
  } else if (t === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(where + ' needs at least ' + schema.minItems + ' item(s)');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(where + ' has more than ' + schema.maxItems + ' items');
    if (schema.uniqueItems && new Set(value.map((x) => JSON.stringify(x))).size !== value.length) errors.push(where + ' has duplicate items');
    if (schema.items) return value.map((x, i) => check(schema.items, x, where + '[' + i + ']', errors));
  } else if (t === 'object') {
    const props = schema.properties || {};
    const out = {};
    for (const k of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) {
        if (schema.additionalProperties === false) errors.push((at ? at + '.' : '') + k + ' is not allowed');
        continue;
      }
      out[k] = check(props[k], value[k], (at ? at + '.' : '') + k, errors);
    }
    for (const r of schema.required || []) {
      if (!(r in value)) errors.push((at ? at + '.' : '') + r + ' is required');
    }
    for (const [k, p] of Object.entries(props)) {
      if (!(k in out) && p && 'default' in p) out[k] = clone(p.default);
    }
    return out;
  }
  return value;
}

function discriminates(branch, value) {
  if (!branch.properties || typeOf(value) !== 'object') return false;
  for (const [k, p] of Object.entries(branch.properties)) {
    if (p && 'const' in p && value[k] === p.const) return true;
  }
  return false;
}

function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function validate(schema, value) {
  const errors = [];
  const out = check(schema, value === undefined ? {} : value, '', errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: out };
}

module.exports = { validate, EMAIL_RE, UUID_RE };
