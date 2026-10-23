//! A second view of the text for matching, as the Node.js scrubber's `invisibleView`: the text
//! without invisible characters (zero-width characters, soft hyphens, variation selectors, tag
//! characters) and without the line breaks of a wrapped line. A value that was split by such a
//! character or break in the original is whole in the view; the view's matches are mapped back
//! to spans of the original text, which is what gets redacted.

/// Most UTF-16 units of text in which wrapped line breaks are looked for (the Node.js limit).
const MAX_WRAP_VIEW_CHARS: usize = 1 << 20;

/// The text without its invisible characters and wrapped line breaks, and where each byte of it
/// came from.
pub(super) struct View {
    pub clean: String,
    /// `map[i]` is the byte index in the original of `clean`'s byte `i`;
    /// `map[clean.len()]` is the original's length.
    pub map: Vec<usize>,
}

impl View {
    /// The span of the original text that holds the span `[start, end)` of the view,
    /// including the removed characters inside it.
    pub fn original_span(&self, start: usize, end: usize) -> (usize, usize) {
        if end > start {
            (self.map[start], self.map[end - 1] + 1)
        } else {
            (self.map[start], self.map[start])
        }
    }
}

/// Zero-width characters, soft hyphen, variation selectors and tag characters.
fn is_invisible(c: char) -> bool {
    matches!(c,
        '\u{200B}'..='\u{200D}'
        | '\u{2060}'
        | '\u{FEFF}'
        | '\u{00AD}'
        | '\u{FE00}'..='\u{FE0F}'
        | '\u{E0000}'..='\u{E007F}'
        | '\u{E0100}'..='\u{E01EF}')
}

/// `[A-Za-z0-9_\-+/=]`, the characters a wrapped token is made of.
fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'+' | b'/' | b'=')
}

fn is_blank(b: u8) -> bool {
    b == b' ' || b == b'\t'
}

fn ten_token_bytes(bytes: &[u8], at: usize) -> bool {
    at + 10 <= bytes.len() && bytes[at..at + 10].iter().all(|&b| is_token_byte(b))
}

/// True when the text at `at` starts a `name =` or `name :` assignment that is not
/// `name ==` + end of line: a line that begins a new `key=value` is not a continuation.
fn starts_assignment(bytes: &[u8], at: usize) -> bool {
    if at >= bytes.len() || !(bytes[at].is_ascii_alphabetic() || bytes[at] == b'_') {
        return false;
    }
    let mut k = at;
    while k < bytes.len() && (bytes[k].is_ascii_alphanumeric() || bytes[k] == b'_') {
        k += 1;
    }
    while k < bytes.len() && is_blank(bytes[k]) {
        k += 1;
    }
    if k >= bytes.len() || !(bytes[k] == b'=' || bytes[k] == b':') {
        return false;
    }
    // Not followed by `=`, blanks and then a line break or the end of the text.
    let mut j = k + 1;
    if j < bytes.len() && bytes[j] == b'=' {
        j += 1;
        while j < bytes.len() && is_blank(bytes[j]) {
            j += 1;
        }
        let at_break = j >= bytes.len()
            || bytes[j] == b'\n'
            || (bytes[j] == b'\r' && j + 1 < bytes.len() && bytes[j + 1] == b'\n');
        if at_break {
            return false;
        }
    }
    true
}

/// The end of a wrapped line break that starts at `start` (blanks, an optional CR, one LF and
/// the blanks after it), when at least ten token characters are on each side and the next line
/// does not begin a new assignment.
fn wrap_break_at(bytes: &[u8], start: usize) -> Option<usize> {
    if start < 10 || !bytes[start - 10..start].iter().all(|&b| is_token_byte(b)) {
        return None;
    }
    let mut j = start;
    while j < bytes.len() && is_blank(bytes[j]) {
        j += 1;
    }
    if j < bytes.len() && bytes[j] == b'\r' {
        j += 1;
    }
    if j >= bytes.len() || bytes[j] != b'\n' {
        return None;
    }
    j += 1;
    while j < bytes.len() && is_blank(bytes[j]) {
        j += 1;
    }
    if !ten_token_bytes(bytes, j) || starts_assignment(bytes, j) {
        return None;
    }
    Some(j)
}

/// The view of `text`, or `None` when the text has no invisible character and no wrapped line
/// break (the view would be the text itself).
pub(super) fn view(text: &str) -> Option<View> {
    let mut runs: Vec<(usize, usize)> = Vec::new();
    for (i, c) in text.char_indices() {
        if is_invisible(c) {
            runs.push((i, i + c.len_utf8()));
        }
    }
    let bytes = text.as_bytes();
    if bytes.contains(&b'\n')
        && text.chars().map(char::len_utf16).sum::<usize>() <= MAX_WRAP_VIEW_CHARS
    {
        for (i, _) in bytes.iter().enumerate().filter(|&(_, &b)| b == b'\n') {
            let mut start = i;
            if start > 0 && bytes[start - 1] == b'\r' {
                start -= 1;
            }
            while start > 0 && is_blank(bytes[start - 1]) {
                start -= 1;
            }
            if let Some(end) = wrap_break_at(bytes, start) {
                runs.push((start, end));
            }
        }
    }
    if runs.is_empty() {
        return None;
    }
    // The runs of both kinds are merged in index order (a break run can contain an invisible
    // character).
    runs.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    let mut clean = String::with_capacity(text.len());
    let mut map = Vec::with_capacity(text.len() + 1);
    let mut pos = 0;
    for (start, end) in runs {
        if end <= pos {
            continue;
        }
        if start > pos {
            clean.push_str(&text[pos..start]);
            map.extend(pos..start);
        }
        pos = pos.max(end);
    }
    clean.push_str(&text[pos..]);
    map.extend(pos..text.len());
    map.push(text.len());
    Some(View { clean, map })
}
