//! Robustness tests for the SIEM export path: the batches the exporter builds from awkward
//! audit entries, the retry buffer under random sizes, and endpoints that answer with garbage,
//! cut-short replies or nothing at all.
//!
//! Inputs are harmless seeded random text and bytes. Every network case runs against a local
//! listener on 127.0.0.1 with a timeout, so a hang fails the case instead of the run.

use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A seeded generator (xorshift64*), so every run sees the same cases.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed.max(1))
    }
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
    fn bytes(&mut self, n: usize) -> Vec<u8> {
        (0..n).map(|_| self.next() as u8).collect()
    }
    /// Any scalar value, including control characters, quotes, backslashes and non-BMP text.
    fn string(&mut self, max: usize) -> String {
        let n = self.below(max + 1);
        (0..n)
            .map(|_| match self.below(6) {
                0 => char::from_u32(self.below(0x20) as u32).unwrap_or(' '),
                1 => ['"', '\\', '/', '\u{7f}', '\u{2028}', '\u{feff}'][self.below(6)],
                2 => char::from_u32(0x10000 + self.below(0x1000) as u32).unwrap_or('x'),
                3 => char::from_u32(0x80 + self.below(0x700) as u32).unwrap_or('x'),
                _ => (0x20 + self.below(0x5f)) as u8 as char,
            })
            .collect()
    }
    fn opt(&mut self, max: usize) -> Option<String> {
        if self.below(3) == 0 {
            None
        } else {
            Some(self.string(max))
        }
    }
}

fn odd_entry(rng: &mut Rng, i: usize) -> AuditEntry {
    AuditEntry {
        id: format!("id-{i}-{}", rng.string(12)),
        timestamp: rng.string(30),
        event: rng.string(20),
        tool_name: rng.string(40),
        status: rng.string(10),
        policy_match: rng.opt(30),
        payload: rng.opt(5000),
        agent_id: rng.opt(30),
        namespace: rng.opt(30),
        anomaly_score: match rng.below(5) {
            0 => Some(f32::NAN),
            1 => Some(f32::INFINITY),
            2 => Some(-0.0),
            3 => Some(f32::MAX),
            _ => None,
        },
        nearest_neighbor: rng.opt(60),
        fusion: None,
    }
}

#[test]
fn batches_of_awkward_entries_are_valid_json_that_keeps_every_event() {
    let mut rng = Rng::new(0xE0F1_0001);
    for round in 0..60 {
        let n = 1 + rng.below(20);
        let batch: Vec<AuditEntry> = (0..n).map(|i| odd_entry(&mut rng, i)).collect();
        let body = reqwest::Client::new()
            .post("https://siem.example.test/ingest")
            .json(&batch)
            .build()
            .unwrap_or_else(|e| panic!("round {round}: the request does not build: {e}"));
        let bytes = body
            .body()
            .and_then(|b| b.as_bytes())
            .expect("buffered body");
        let parsed: serde_json::Value = serde_json::from_slice(bytes)
            .unwrap_or_else(|e| panic!("round {round}: the batch is not valid JSON: {e}"));
        let array = parsed.as_array().expect("a batch is a JSON array");
        assert_eq!(array.len(), n, "round {round}: events lost in the batch");
        for (sent, got) in batch.iter().zip(array) {
            assert_eq!(got["id"].as_str(), Some(sent.id.as_str()), "round {round}");
            assert_eq!(
                got["payload"].as_str(),
                sent.payload.as_deref(),
                "round {round}"
            );
        }
        // A batch cut short at any point is never valid JSON, so a receiver that loses the end
        // of the request cannot read it as a smaller batch.
        let text = std::str::from_utf8(bytes).unwrap();
        for (i, _) in text.char_indices().step_by(499) {
            assert!(
                serde_json::from_str::<serde_json::Value>(&text[..i]).is_err(),
                "round {round}: a batch cut at byte {i} still parses"
            );
        }
    }
}

#[test]
fn the_retry_buffer_keeps_its_invariants_under_random_sizes() {
    let mut rng = Rng::new(0xE0F1_0002);
    for round in 0..30 {
        let max_events = 1 + rng.below(60);
        let max_bytes = 300 + rng.below(40_000);
        let mut buffer = Buffer::new(max_events, max_bytes);
        for i in 0..400 {
            let mut e = odd_entry(&mut rng, i);
            if rng.below(10) == 0 {
                e.payload = Some("x".repeat(rng.below(60_000)));
            }
            buffer.push(e);
            assert!(
                buffer.len() <= max_events,
                "round {round}: event cap broken"
            );
            let real: usize = buffer.entries.iter().map(approx_size).sum();
            assert_eq!(buffer.bytes, real, "round {round}: byte counter drifted");
            assert!(real <= max_bytes, "round {round}: byte cap broken");
            if rng.below(7) == 0 && !buffer.is_empty() {
                let n = buffer.chunk_len(1 + rng.below(50), 200 + rng.below(30_000));
                assert!(n >= 1 && n <= buffer.len(), "round {round}: chunk of {n}");
                buffer.drain_front(n);
            }
        }
        // Draining the buffer in chunks always ends.
        let mut steps = 0;
        while !buffer.is_empty() {
            let n = buffer.chunk_len(MAX_REQUEST_EVENTS, MAX_REQUEST_BYTES);
            assert!(n >= 1, "round {round}: an empty chunk would loop forever");
            buffer.drain_front(n);
            steps += 1;
            assert!(steps <= 10_000);
        }
        assert_eq!(buffer.bytes, 0);
    }
}

/// A one-connection listener that reads the request and then plays `reply` (None = hold the
/// connection open without answering).
async fn endpoint(reply: Option<Vec<u8>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let reply = reply.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 65536];
                let _ = tokio::time::timeout(Duration::from_secs(2), sock.read(&mut buf)).await;
                match reply {
                    Some(bytes) => {
                        let _ = sock.write_all(&bytes).await;
                        let _ = sock.shutdown().await;
                    }
                    None => tokio::time::sleep(Duration::from_secs(30)).await,
                }
            });
        }
    });
    format!("http://127.0.0.1:{port}/")
}

fn exporter_with_short_timeouts(endpoint: &str) -> SiemExporter {
    SiemExporter::with_timeouts(
        SiemConfig {
            endpoint: Some(endpoint.to_string()),
            token: None,
            batch_size: 100,
        },
        Duration::from_millis(500),
        Duration::from_secs(2),
    )
}

async fn send_one(reply: Option<Vec<u8>>) -> bool {
    let ep = endpoint(reply).await;
    let exporter = exporter_with_short_timeouts(&ep);
    let mut rng = Rng::new(7);
    let chunk = vec![odd_entry(&mut rng, 0)];
    tokio::time::timeout(Duration::from_secs(10), exporter.send_chunk(&ep, &chunk))
        .await
        .expect("the export call hung")
}

#[tokio::test]
async fn an_endpoint_that_answers_with_garbage_is_a_failure_not_a_success() {
    let mut rng = Rng::new(0xE0F1_0003);
    for i in 0..25 {
        let mut bytes = rng.bytes_in(1, 600);
        // Keep it from starting like an HTTP reply.
        bytes[0] = 0xfe;
        assert!(
            !send_one(Some(bytes)).await,
            "garbage reply #{i} counted as delivered"
        );
    }
}

#[tokio::test]
async fn a_status_line_or_header_block_cut_short_is_a_failure() {
    let full = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    // Every cut before the blank line that ends the headers.
    let end = full.find("\r\n\r\n").unwrap();
    for len in (0..end).step_by(3) {
        let reply = full.as_bytes()[..len].to_vec();
        assert!(
            !send_one(Some(reply)).await,
            "a reply cut at byte {len} of the headers counted as delivered"
        );
    }
}

#[tokio::test]
async fn an_endpoint_that_closes_without_a_reply_or_never_answers_is_a_failure() {
    assert!(!send_one(Some(Vec::new())).await);
    assert!(!send_one(None).await);
}

#[tokio::test]
async fn odd_status_lines_never_count_as_delivered() {
    for line in [
        "HTTP/1.1 999 X\r\nContent-Length: 0\r\n\r\n",
        "HTTP/1.1 -1 X\r\nContent-Length: 0\r\n\r\n",
        "HTTP/1.1 20 X\r\nContent-Length: 0\r\n\r\n",
        "HTTP/9.9 200 OK\r\nContent-Length: 0\r\n\r\n",
        "200 OK\r\n\r\n",
        "HTTP/1.1 301 Moved\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\n\r\n",
        "HTTP/1.1 500 X\r\nContent-Length: 0\r\n\r\n",
    ] {
        assert!(
            !send_one(Some(line.as_bytes().to_vec())).await,
            "{line:?} counted as delivered"
        );
    }
}

#[tokio::test]
async fn a_success_reply_with_a_cut_body_never_panics() {
    // The status line says delivered; the body that follows is cut. Both answers are fine, the
    // call must only return.
    for reply in [
        "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nabc",
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nab",
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n",
    ] {
        let _ = send_one(Some(reply.as_bytes().to_vec())).await;
    }
}

impl Rng {
    /// `base` plus a random number of bytes below `extra`.
    fn bytes_in(&mut self, base: usize, extra: usize) -> Vec<u8> {
        let n = base + self.below(extra);
        self.bytes(n)
    }
}
