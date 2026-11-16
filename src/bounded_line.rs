//! A line reader with a size limit, for the JSON-RPC lines the gateway reads from stdin.
//!
//! `AsyncBufReadExt::lines` keeps reading until it finds a newline, so a peer that never sends one makes
//! the process buffer without a bound. `read_line_bounded` keeps at most `max` bytes: a longer line is
//! skipped as it streams past (nothing beyond the limit is stored) and reported as `TooLong`.

use tokio::io::{self, AsyncBufRead, AsyncBufReadExt};

/// Largest stdin JSON-RPC line the gateway accepts, in bytes. A frame may carry a base64 image, so the
/// limit is well above the 1 MiB WebSocket message limit.
pub const MAX_STDIN_LINE_BYTES: usize = 16 * 1024 * 1024;

/// What `read_line_bounded` found.
#[derive(Debug, PartialEq, Eq)]
pub enum BoundedLine {
    /// A complete line, without its line ending.
    Line(String),
    /// The line was longer than the limit. It has been read to its end and dropped.
    TooLong,
    /// The input ended before any byte of a new line.
    Eof,
}

/// Read one line of at most `max` bytes (the line ending not counted).
pub async fn read_line_bounded<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> io::Result<BoundedLine> {
    let mut line: Vec<u8> = Vec::new();
    let mut too_long = false;
    let mut any = false;
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            break;
        }
        any = true;
        let (take, done) = match chunk.iter().position(|b| *b == b'\n') {
            Some(i) => (i, true),
            None => (chunk.len(), false),
        };
        if !too_long {
            if line.len() + take > max {
                too_long = true;
                line = Vec::new();
            } else {
                line.extend_from_slice(&chunk[..take]);
            }
        }
        reader.consume(if done { take + 1 } else { take });
        if done {
            break;
        }
    }
    if !any {
        return Ok(BoundedLine::Eof);
    }
    if too_long {
        return Ok(BoundedLine::TooLong);
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(BoundedLine::Line(
        String::from_utf8_lossy(&line).into_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, BufReader};

    #[tokio::test]
    async fn reads_lines_and_eof() {
        let mut r = BufReader::new(&b"one\r\ntwo\nlast"[..]);
        assert_eq!(
            read_line_bounded(&mut r, 16).await.unwrap(),
            BoundedLine::Line("one".into())
        );
        assert_eq!(
            read_line_bounded(&mut r, 16).await.unwrap(),
            BoundedLine::Line("two".into())
        );
        assert_eq!(
            read_line_bounded(&mut r, 16).await.unwrap(),
            BoundedLine::Line("last".into())
        );
        assert_eq!(
            read_line_bounded(&mut r, 16).await.unwrap(),
            BoundedLine::Eof
        );
    }

    #[tokio::test]
    async fn a_line_at_the_limit_is_kept_and_one_byte_over_is_not() {
        let mut r = BufReader::new(&b"abcd\nabcde\nok\n"[..]);
        assert_eq!(
            read_line_bounded(&mut r, 4).await.unwrap(),
            BoundedLine::Line("abcd".into())
        );
        assert_eq!(
            read_line_bounded(&mut r, 4).await.unwrap(),
            BoundedLine::TooLong
        );
        assert_eq!(
            read_line_bounded(&mut r, 4).await.unwrap(),
            BoundedLine::Line("ok".into())
        );
    }

    /// 64 MiB with no newline until the end, read through a 4 KiB buffer: the line is dropped as it
    /// streams, the next line is still read, and the reader never held more than the buffer.
    #[tokio::test]
    async fn an_oversized_line_is_skipped_without_buffering_it() {
        let huge = tokio::io::repeat(b'a').take(64 * 1024 * 1024);
        let stream = huge.chain(&b"\n{\"id\":1}\n"[..]);
        let mut r = BufReader::with_capacity(4096, stream);
        assert_eq!(
            read_line_bounded(&mut r, 1024).await.unwrap(),
            BoundedLine::TooLong
        );
        assert_eq!(
            read_line_bounded(&mut r, 1024).await.unwrap(),
            BoundedLine::Line("{\"id\":1}".into())
        );
        assert_eq!(
            read_line_bounded(&mut r, 1024).await.unwrap(),
            BoundedLine::Eof
        );
    }

    #[tokio::test]
    async fn an_oversized_last_line_without_newline_is_too_long() {
        let mut r = BufReader::new(&b"abcdefgh"[..]);
        assert_eq!(
            read_line_bounded(&mut r, 4).await.unwrap(),
            BoundedLine::TooLong
        );
        assert_eq!(
            read_line_bounded(&mut r, 4).await.unwrap(),
            BoundedLine::Eof
        );
    }
}
