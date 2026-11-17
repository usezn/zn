//! MCP and A2A frames: the validation that decides what a client message is, and the rewrite of its arguments.
//!
//! Oracle: a frame that is valid JSON and repeats an object key at any depth must be refused. The check
//! below is written independently of the gateway's own walk (its own small JSON reader, with an explicit
//! stack so any nesting depth is read without recursion), so a bypass of the gateway's guard shows up as a
//! disagreement and not as two copies of the same mistake.
#![no_main]

use libfuzzer_sys::fuzz_target;
use std::collections::HashSet;
use zn::jsonrpc::{
    has_duplicate_keys, nesting_exceeds, validate_jsonrpc, with_arguments, JsonRpcValidation,
    MAX_FRAME_DEPTH,
};

fn skip_ws(b: &[u8], i: &mut usize) {
    while *i < b.len() && matches!(b[*i], b' ' | b'\t' | b'\n' | b'\r') {
        *i += 1;
    }
}

fn hex4(b: &[u8], i: usize) -> Option<u32> {
    let h = b.get(i..i + 4)?;
    let mut v = 0u32;
    for c in h {
        v = v * 16 + (*c as char).to_digit(16)?;
    }
    Some(v)
}

/// Read a JSON string at `b[*i]` (which must be a quote) and return its decoded text.
fn read_string(b: &[u8], i: &mut usize) -> Option<String> {
    if b.get(*i) != Some(&b'"') {
        return None;
    }
    *i += 1;
    let mut out: Vec<u8> = Vec::new();
    loop {
        let c = *b.get(*i)?;
        *i += 1;
        match c {
            b'"' => return String::from_utf8(out).ok(),
            0..=0x1f => return None,
            b'\\' => {
                let e = *b.get(*i)?;
                *i += 1;
                let ch = match e {
                    b'"' => '"',
                    b'\\' => '\\',
                    b'/' => '/',
                    b'b' => '\u{8}',
                    b'f' => '\u{c}',
                    b'n' => '\n',
                    b'r' => '\r',
                    b't' => '\t',
                    b'u' => {
                        let hi = hex4(b, *i)?;
                        *i += 4;
                        let cp = if (0xD800..0xDC00).contains(&hi) {
                            if b.get(*i) != Some(&b'\\') || b.get(*i + 1) != Some(&b'u') {
                                return None;
                            }
                            let lo = hex4(b, *i + 2)?;
                            if !(0xDC00..0xE000).contains(&lo) {
                                return None;
                            }
                            *i += 6;
                            0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                        } else if (0xDC00..0xE000).contains(&hi) {
                            return None;
                        } else {
                            hi
                        };
                        char::from_u32(cp)?
                    }
                    _ => return None,
                };
                let mut buf = [0u8; 4];
                out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
            }
            _ => out.push(c),
        }
    }
}

fn read_number(b: &[u8], i: &mut usize) -> Option<()> {
    if b.get(*i) == Some(&b'-') {
        *i += 1;
    }
    match b.get(*i)? {
        b'0' => *i += 1,
        b'1'..=b'9' => {
            while matches!(b.get(*i), Some(b'0'..=b'9')) {
                *i += 1;
            }
        }
        _ => return None,
    }
    if b.get(*i) == Some(&b'.') {
        *i += 1;
        if !matches!(b.get(*i), Some(b'0'..=b'9')) {
            return None;
        }
        while matches!(b.get(*i), Some(b'0'..=b'9')) {
            *i += 1;
        }
    }
    if matches!(b.get(*i), Some(b'e' | b'E')) {
        *i += 1;
        if matches!(b.get(*i), Some(b'+' | b'-')) {
            *i += 1;
        }
        if !matches!(b.get(*i), Some(b'0'..=b'9')) {
            return None;
        }
        while matches!(b.get(*i), Some(b'0'..=b'9')) {
            *i += 1;
        }
    }
    Some(())
}

/// `None` when the text is not one valid JSON value; otherwise whether some object repeats a decoded key.
fn repeats_a_key(text: &str) -> Option<bool> {
    let b = text.as_bytes();
    let mut i = 0usize;
    let mut repeated = false;
    // One entry per open container: the keys seen so far for an object, `None` for an array.
    let mut stack: Vec<Option<HashSet<String>>> = Vec::new();
    // Read `"key" :` into the object on top of the stack.
    fn read_key(
        b: &[u8],
        i: &mut usize,
        set: &mut HashSet<String>,
        repeated: &mut bool,
    ) -> Option<()> {
        skip_ws(b, i);
        let key = read_string(b, i)?;
        if !set.insert(key) {
            *repeated = true;
        }
        skip_ws(b, i);
        if b.get(*i) != Some(&b':') {
            return None;
        }
        *i += 1;
        Some(())
    }
    let mut want_value = true;
    loop {
        if want_value {
            skip_ws(b, &mut i);
            match *b.get(i)? {
                b'{' => {
                    i += 1;
                    skip_ws(b, &mut i);
                    if b.get(i) == Some(&b'}') {
                        i += 1;
                        want_value = false;
                    } else {
                        let mut set = HashSet::new();
                        read_key(b, &mut i, &mut set, &mut repeated)?;
                        stack.push(Some(set));
                    }
                }
                b'[' => {
                    i += 1;
                    skip_ws(b, &mut i);
                    if b.get(i) == Some(&b']') {
                        i += 1;
                        want_value = false;
                    } else {
                        stack.push(None);
                    }
                }
                b'"' => {
                    read_string(b, &mut i)?;
                    want_value = false;
                }
                b't' => {
                    b.get(i..i + 4).filter(|s| *s == b"true")?;
                    i += 4;
                    want_value = false;
                }
                b'f' => {
                    b.get(i..i + 5).filter(|s| *s == b"false")?;
                    i += 5;
                    want_value = false;
                }
                b'n' => {
                    b.get(i..i + 4).filter(|s| *s == b"null")?;
                    i += 4;
                    want_value = false;
                }
                _ => {
                    read_number(b, &mut i)?;
                    want_value = false;
                }
            }
        } else {
            skip_ws(b, &mut i);
            let Some(top) = stack.last_mut() else {
                return if i == b.len() { Some(repeated) } else { None };
            };
            match (*b.get(i)?, top) {
                (b',', Some(set)) => {
                    i += 1;
                    read_key(b, &mut i, set, &mut repeated)?;
                    want_value = true;
                }
                (b',', None) => {
                    i += 1;
                    want_value = true;
                }
                (b'}', Some(_)) | (b']', None) => {
                    i += 1;
                    stack.pop();
                }
                _ => return None,
            }
        }
    }
}

fuzz_target!(|data: &[u8]| {
    let Ok(frame) = std::str::from_utf8(data) else {
        return;
    };
    let verdict = validate_jsonrpc(frame);
    let refused = matches!(verdict, JsonRpcValidation::Error { .. });
    if !refused {
        // A frame that is not refused was read to the end, repeats no key and is not nested too deep.
        assert!(!has_duplicate_keys(frame));
        assert!(!nesting_exceeds(frame, MAX_FRAME_DEPTH));
    }
    // Oracle: valid JSON with a repeated key at any depth is always refused, whatever its nesting.
    if repeats_a_key(frame) == Some(true) {
        assert!(refused, "a frame with a repeated key was not refused");
    }
    if let JsonRpcValidation::ToolCall {
        tool_name,
        arguments,
        source,
        ..
    } = verdict
    {
        assert!(!tool_name.is_empty());
        // The arguments handed to the policy check are always valid JSON text.
        assert!(serde_json::from_str::<serde_json::Value>(&arguments).is_ok());
        let _ = with_arguments(frame, &arguments, source);
        let _ = with_arguments(frame, "{\"redacted\":true}", source);
    }
});
