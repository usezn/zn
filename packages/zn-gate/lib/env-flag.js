'use strict';

/**
 * True when the hardening flag `name` (ZN_STRICT, ZN_BLOCK_TRUNCATED) is set to "1", the only value that turns it
 * on. Any other value (true, yes, on...) leaves it off, so it is said once on stderr rather than ignored silently.
 * Same rule and wording as env_flag in the Python package. Never writes to stdout: hooks talk JSON there.
 */
const warned = new Set();

function envFlag(name) {
  const value = process.env[name];
  if (value === '1') return true;
  if (value !== undefined && value !== '' && value !== '0') {
    const key = name + '\0' + value;
    if (!warned.has(key)) {
      warned.add(key);
      try {
        process.stderr.write(`zn_gate: ${name} is set to '${value.slice(0, 20)}', but only ${name}=1 turns it on, so it is off\n`);
      } catch (_) { /* a closed stderr must not change a verdict */ }
    }
  }
  return false;
}

const LOCAL_ONLY_TRUE = new Set(['1', 'true', 'yes', 'on']);
const LOCAL_ONLY_FALSE = new Set(['', '0', 'false', 'no', 'off']);

/**
 * True when ZN_LOCAL_ONLY asks for local-only use. 1, true, yes and on (any case, spaces ignored) turn it on;
 * unset, empty, 0, false, no and off leave it off. Any other value also turns it ON: the setting exists to keep
 * text on this machine, so a value this code does not recognise must not send anything. Said once on stderr.
 * Same rule and wording as local_only_env in the Python package.
 */
function localOnlyEnv() {
  const raw = process.env.ZN_LOCAL_ONLY;
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (LOCAL_ONLY_TRUE.has(value)) return true;
  if (LOCAL_ONLY_FALSE.has(value)) return false;
  const key = 'ZN_LOCAL_ONLY\0' + raw;
  if (!warned.has(key)) {
    warned.add(key);
    try {
      process.stderr.write(`zn_gate: ZN_LOCAL_ONLY is set to '${raw.slice(0, 20)}', which is not a value zn_gate knows, so local-only is ON (nothing is sent to the cloud). Use 1, true, yes or on to turn it on; unset, empty, 0, false, no or off to leave it off\n`);
    } catch (_) { /* a closed stderr must not change a verdict */ }
  }
  return true;
}

module.exports = { envFlag, localOnlyEnv, _warned: warned };
