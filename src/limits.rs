//! Size bounds for one tool call: the stdio frame, the text the neural check
//! embeds, and the copies the audit vault and the vector memory keep.
//!
//! The rules engine and the loop breaker still see the whole call. These
//! bounds only stop one very large call from costing memory, CPU and disk in
//! proportion to its size.

use crate::ai::ModelBackend;
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

/// Default for `server.stdio_max_message_bytes`: 1 MiB, like the WebSocket path.
pub const DEFAULT_STDIO_MAX_MESSAGE_BYTES: usize = 1024 * 1024;

/// Bytes of one neural window. A text longer than this is checked as its
/// first and its last window, so text hidden in the middle of a very long call
/// is the only part not embedded (the rules engine still scans all of it).
pub const NEURAL_WINDOW_BYTES: usize = 2048;

/// Largest copy of a call the audit vault stores; the rest is replaced by the
/// original length and SHA-256.
pub const AUDIT_PAYLOAD_MAX_BYTES: usize = 16 * 1024;

/// Largest text the vector memory stores per call.
pub const MEMORY_TEXT_MAX_BYTES: usize = 1024;

/// One frame read from stdin.
#[derive(Debug, PartialEq, Eq)]
pub enum Frame {
    /// A complete line, without its line ending.
    Line(String),
    /// A line over the limit. It was discarded without being buffered.
    TooLarge { len: usize },
}

/// Reads the next line, keeping at most `max` bytes of it in memory.
/// A longer line is skipped up to its end and reported as `TooLarge`.
/// Returns `None` at end of input.
pub async fn read_frame<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> std::io::Result<Option<Frame>> {
    let mut buf: Vec<u8> = Vec::new();
    let mut total = 0usize;
    let mut seen_any = false;
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            break;
        }
        seen_any = true;
        let (take, found_newline) = match chunk.iter().position(|&b| b == b'\n') {
            Some(i) => (i, true),
            None => (chunk.len(), false),
        };
        if total.saturating_add(take) <= max.saturating_add(1) {
            buf.extend_from_slice(&chunk[..take]);
        } else {
            buf = Vec::new();
        }
        total = total.saturating_add(take);
        reader.consume(take + usize::from(found_newline));
        if found_newline {
            break;
        }
    }
    if !seen_any {
        return Ok(None);
    }
    if buf.last() == Some(&b'\r') && total <= max.saturating_add(1) {
        buf.pop();
        total -= 1;
    }
    if total > max {
        return Ok(Some(Frame::TooLarge { len: total }));
    }
    String::from_utf8(buf)
        .map(|s| Some(Frame::Line(s)))
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// Message of the JSON-RPC error for a frame over the stdio limit.
pub fn frame_too_large_message(len: usize, max: usize) -> String {
    format!(
        "Message too large: {len} bytes exceeds the {max} byte limit. \
         Raise server.stdio_max_message_bytes in the config file to accept larger messages."
    )
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// The windows of `text` that the neural check embeds: the text itself when it
/// fits in one window, otherwise its first and its last window.
pub fn neural_windows(text: &str) -> Vec<&str> {
    if text.len() <= NEURAL_WINDOW_BYTES {
        return vec![text];
    }
    let head_end = floor_char_boundary(text, NEURAL_WINDOW_BYTES);
    let tail_start = ceil_char_boundary(text, text.len() - NEURAL_WINDOW_BYTES);
    vec![&text[..head_end], &text[tail_start..]]
}

/// Embeds `text` in bounded windows and returns the vector and the classifier
/// probability. With several windows the vector is the normalized mean of the
/// window vectors (the model itself mean-pools) and the probability is the
/// highest of the windows, so an attack in either end still fires the check.
pub fn embed_bounded<M: ModelBackend + ?Sized>(
    model: &M,
    text: &str,
) -> anyhow::Result<(Vec<f32>, Option<f32>)> {
    let windows = neural_windows(text);
    let mut sum: Vec<f32> = Vec::new();
    let mut prob: Option<f32> = None;
    let mut first: Vec<f32> = Vec::new();
    for (i, w) in windows.iter().enumerate() {
        let v = model.embed(w)?;
        if let Some(p) = model.classify(&v).ok().flatten() {
            prob = Some(prob.map_or(p, |q| q.max(p)));
        }
        if i == 0 {
            sum = vec![0.0; v.len()];
            first = v.clone();
        }
        for (s, x) in sum.iter_mut().zip(v.iter()) {
            *s += x;
        }
    }
    if windows.len() == 1 {
        return Ok((first, prob));
    }
    let norm = sum.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in sum.iter_mut() {
            *x /= norm;
        }
    }
    Ok((sum, prob))
}

/// `text` when it fits in `max` bytes, otherwise its first bytes followed by
/// the original length and SHA-256.
pub fn bounded_stored_text(text: &str, max: usize) -> Cow<'_, str> {
    if text.len() <= max {
        return Cow::Borrowed(text);
    }
    let cut = floor_char_boundary(text, max);
    let digest = hex::encode(Sha256::digest(text.as_bytes()));
    Cow::Owned(format!(
        "{}...[truncated: {} bytes, sha256 {}]",
        &text[..cut],
        text.len(),
        digest
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    async fn frames(input: &[u8], max: usize) -> Vec<Frame> {
        let mut r = tokio::io::BufReader::with_capacity(16, input);
        let mut out = Vec::new();
        while let Some(f) = read_frame(&mut r, max).await.unwrap() {
            out.push(f);
        }
        out
    }

    #[tokio::test]
    async fn small_frames_pass_through_and_crlf_is_stripped() {
        let got = frames(b"{\"a\":1}\r\nsecond\nlast-without-newline", 64).await;
        assert_eq!(
            got,
            vec![
                Frame::Line("{\"a\":1}".into()),
                Frame::Line("second".into()),
                Frame::Line("last-without-newline".into()),
            ]
        );
    }

    #[tokio::test]
    async fn a_frame_over_the_limit_is_refused_and_the_next_one_still_reads() {
        let mut input = vec![b'x'; 5000];
        input.extend_from_slice(b"\nok\n");
        let got = frames(&input, 1000).await;
        assert_eq!(
            got,
            vec![Frame::TooLarge { len: 5000 }, Frame::Line("ok".into())]
        );
    }

    #[tokio::test]
    async fn a_frame_of_exactly_the_limit_is_accepted() {
        let mut input = vec![b'y'; 100];
        input.push(b'\n');
        let got = frames(&input, 100).await;
        assert_eq!(got.len(), 1);
        assert!(matches!(&got[0], Frame::Line(s) if s.len() == 100));
        let mut over = vec![b'y'; 101];
        over.push(b'\n');
        assert_eq!(frames(&over, 100).await, vec![Frame::TooLarge { len: 101 }]);
    }

    #[tokio::test]
    async fn an_oversized_frame_is_never_buffered_whole() {
        // 4 MiB with no newline, read through a 16-byte buffer: the reader
        // reports the size without growing past the limit.
        let input = vec![b'z'; 4 * 1024 * 1024];
        let got = frames(&input, 1024).await;
        assert_eq!(
            got,
            vec![Frame::TooLarge {
                len: 4 * 1024 * 1024
            }]
        );
    }

    #[test]
    fn the_error_message_names_the_limit_and_the_setting() {
        let m = frame_too_large_message(2_000_000, 1_048_576);
        assert!(m.contains("2000000"), "{m}");
        assert!(m.contains("1048576"), "{m}");
        assert!(m.contains("server.stdio_max_message_bytes"), "{m}");
    }

    #[test]
    fn short_text_is_stored_whole_and_long_text_as_prefix_length_and_hash() {
        assert_eq!(bounded_stored_text("short", 64), "short");
        let long = "é".repeat(5000);
        let got = bounded_stored_text(&long, 1000);
        assert!(got.len() < 1200, "stored {} bytes", got.len());
        assert!(got.starts_with("éé"));
        assert!(got.contains("10000 bytes"), "{got}");
        let digest = hex::encode(Sha256::digest(long.as_bytes()));
        assert!(got.contains(&digest), "{got}");
    }

    #[test]
    fn windows_cover_head_and_tail_on_char_boundaries() {
        assert_eq!(neural_windows("abc"), vec!["abc"]);
        let text = format!("HEAD{}TAIL", "é".repeat(100_000));
        let w = neural_windows(&text);
        assert_eq!(w.len(), 2);
        assert!(w[0].starts_with("HEAD") && w[0].len() <= NEURAL_WINDOW_BYTES);
        assert!(w[1].ends_with("TAIL") && w[1].len() <= NEURAL_WINDOW_BYTES);
    }

    struct Mock {
        seen: Mutex<Vec<usize>>,
    }

    impl ModelBackend for Mock {
        fn embed(&self, text: &str) -> anyhow::Result<Vec<f32>> {
            self.seen.lock().unwrap().push(text.len());
            Ok(vec![if text.contains("ATTACK") { 1.0 } else { 0.0 }, 1.0])
        }
        fn classify(&self, v: &[f32]) -> anyhow::Result<Option<f32>> {
            Ok(Some(v[0]))
        }
        fn name(&self) -> &str {
            "mock"
        }
        fn dim(&self) -> usize {
            2
        }
    }

    #[test]
    fn a_huge_text_is_embedded_in_bounded_windows_and_an_attack_at_the_end_still_fires() {
        let model = Mock {
            seen: Mutex::new(Vec::new()),
        };
        let text = format!("{}ATTACK", "a".repeat(8 * 1024 * 1024));
        let (vec, prob) = embed_bounded(&model, &text).unwrap();
        let seen = model.seen.lock().unwrap();
        assert_eq!(seen.len(), 2, "head and tail windows");
        assert!(seen.iter().all(|&n| n <= NEURAL_WINDOW_BYTES), "{seen:?}");
        assert_eq!(prob, Some(1.0));
        assert_eq!(vec.len(), 2);
    }

    #[test]
    fn a_short_text_is_embedded_once_unchanged() {
        let model = Mock {
            seen: Mutex::new(Vec::new()),
        };
        let (_, prob) = embed_bounded(&model, "hello").unwrap();
        assert_eq!(*model.seen.lock().unwrap(), vec![5]);
        assert_eq!(prob, Some(0.0));
    }
}
