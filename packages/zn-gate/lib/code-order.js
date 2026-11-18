'use strict';

// Plain code-unit ordering for sorts whose result must not depend on the user's language.
// String.prototype.localeCompare follows the locale of the computer (Turkish, Swedish...),
// so the same names could come out in a different order, or a different item could be kept
// or listed first. For ASCII names and ISO timestamps this gives the order a byte sort gives.

/** Comparator for Array.prototype.sort: a before b by UTF-16 code unit, whatever the locale. */
function byCode(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

module.exports = { byCode };
