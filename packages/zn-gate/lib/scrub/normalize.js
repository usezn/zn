'use strict';
/**
 * Normalised view for secret detection.
 *
 * Two plain-text encodings split or hide a secret without changing what a
 * shell or a URL parser sees:
 *   - shell quoting: AKIA""rest, 'AKIA''rest', key='part''part'
 *   - percent-encoding: %41KIA..., api_key=%66ake..., api_key%3Dvalue
 *
 * normalisedView(text) returns the text with adjacent same-type quote pairs
 * between word characters removed (one shell word) and valid %XX sequences
 * decoded when the decoded byte is a printable, non-space ASCII character
 * (so %20 and non-ASCII bytes stay as they are). The detectors run on this
 * view and the spans are mapped back to the original text, so the whole
 * original word or encoded value is replaced.
 *
 * Linear time: one left-to-right pass. The number of decoded sequences is
 * capped (MAX_DECODES); past the cap the rest stays literal.
 */

const MAX_DECODES = 200000;
const Q_SINGLE = 0x27;
const Q_DOUBLE = 0x22;
const PERCENT = 0x25;

function hex(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

// Characters of a shell word on either side of a quote pair that joins it.
function wordish(c) {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ||
    c === 0x5f || c === 0x2d || c === 0x2b || c === 0x2f || c === 0x2e || c === PERCENT;
}

function normalisedView(text) {
  const n = text.length;
  let hasPercent = false;
  let hasPair = false;
  for (let i = 0; i < n - 1; i++) {
    const c = text.charCodeAt(i);
    if (c === PERCENT) hasPercent = true;
    else if ((c === Q_SINGLE || c === Q_DOUBLE) && text.charCodeAt(i + 1) === c) hasPair = true;
    if (hasPercent && hasPair) break;
  }
  if (!hasPercent && !hasPair) return null;

  const starts = new Int32Array(n + 1);
  const ends = new Int32Array(n + 1);
  let clean = '';
  const parts = [];
  let c = 0;
  let decodes = 0;
  let changed = false;
  let i = 0;
  while (i < n) {
    const ch = text.charCodeAt(i);
    if ((ch === Q_SINGLE || ch === Q_DOUBLE) && i > 0 && i + 1 < n && text.charCodeAt(i + 1) === ch && wordish(text.charCodeAt(i - 1))) {
      let j = i;
      while (j + 1 < n && text.charCodeAt(j) === ch && text.charCodeAt(j + 1) === ch) j += 2;
      if (j < n && wordish(text.charCodeAt(j))) { i = j; changed = true; continue; }
    }
    if (ch === PERCENT && i + 2 < n + 0 && decodes < MAX_DECODES) {
      const h = hex(text.charCodeAt(i + 1));
      const l = h < 0 ? -1 : hex(text.charCodeAt(i + 2));
      if (l >= 0) {
        const b = h * 16 + l;
        if (b > 0x20 && b < 0x7f) {
          decodes++;
          starts[c] = i; ends[c] = i + 3; c++;
          parts.push(String.fromCharCode(b));
          i += 3; changed = true;
          continue;
        }
      }
    }
    starts[c] = i; ends[c] = i + 1; c++;
    parts.push(text[i]);
    i++;
  }
  if (!changed) return null;
  clean = parts.join('');
  starts[c] = n; ends[c] = n;
  return { clean, starts: starts.subarray(0, c + 1), ends: ends.subarray(0, c + 1) };
}

module.exports = { normalisedView, MAX_DECODES };
