//! The bounded line reader behind stdin and the upstream stdio servers: arbitrary bytes, any limit, any
//! chunking. A returned line is never longer than the limit, the reader never panics, every byte is
//! consumed, and the lines match a plain split of the same input.
#![no_main]

use libfuzzer_sys::fuzz_target;
use tokio::io::BufReader;
use zn::bounded_line::{read_line_bounded, BoundedLine};

fuzz_target!(|data: &[u8]| {
    // First byte: the limit (0..=255) so the boundary is hit often. Second: the reader's buffer size, so
    // lines are split across chunks. The rest is the stream.
    let [max, cap, rest @ ..] = data else {
        return;
    };
    let max = *max as usize;
    let cap = (*cap as usize % 64) + 1;
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime");
    rt.block_on(async {
        let mut reader = BufReader::with_capacity(cap, rest);
        // Reference: split on b'\n'. A final piece without a newline is a line when it is not empty.
        let mut expected: Vec<&[u8]> = rest.split(|b| *b == b'\n').collect();
        if rest.last() == Some(&b'\n') || rest.is_empty() {
            expected.pop();
        }
        for want in expected {
            let got = read_line_bounded(&mut reader, max).await.expect("read");
            let bytes = want.strip_suffix(b"\r").unwrap_or(want);
            match got {
                BoundedLine::Line(line) => {
                    // Invalid UTF-8 is replaced, which can only lengthen the text, so compare bytes of the source.
                    assert!(want.len() <= max, "a line over the limit was returned");
                    assert_eq!(line, String::from_utf8_lossy(bytes));
                    assert!(!line.contains('\n'));
                }
                BoundedLine::TooLong => {
                    assert!(want.len() > max, "a line within the limit was dropped")
                }
                BoundedLine::Eof => panic!("end of input before the last line"),
            }
        }
        // Everything was consumed.
        assert_eq!(
            read_line_bounded(&mut reader, max).await.expect("read"),
            BoundedLine::Eof
        );
    });
});
