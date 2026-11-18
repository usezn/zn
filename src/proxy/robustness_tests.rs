//! Robustness tests for the MCP servers file and for the reply lines read from an upstream
//! stdio server.
//!
//! Inputs are harmless seeded random text and bytes, plus every truncation of a small valid
//! file. Each file case runs in its own thread with a timeout. A test whose name starts with
//! `finding_` and is `#[ignore]` documents a failure that exists today.

use super::*;
use std::sync::mpsc;
use std::time::Duration;

/// Run one case in its own thread. A panic and a hang both fail with the case name.
fn guarded<T: Send + 'static>(what: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = mpsc::channel();
    let handle = std::thread::Builder::new()
        .name(format!("case-{what}"))
        .spawn(move || {
            let _ = tx.send(f());
        })
        .expect("thread starts");
    match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(v) => {
            let _ = handle.join();
            v
        }
        Err(mpsc::RecvTimeoutError::Timeout) => panic!("HANG: {what} took more than 30 s"),
        Err(mpsc::RecvTimeoutError::Disconnected) => panic!("PANIC: {what}"),
    }
}

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
    fn text(&mut self, n: usize) -> String {
        (0..n)
            .map(|_| match self.below(30) {
                0 => '\n',
                _ => (0x20 + self.below(0x5f)) as u8 as char,
            })
            .collect()
    }
    fn soup(&mut self) -> String {
        const TOKENS: &[&str] = &[
            "{",
            "}",
            "[",
            "]",
            "\"",
            "\\",
            ":",
            ",",
            "null",
            "true",
            "0",
            "1e999",
            "\"mcpServers\"",
            "\"command\"",
            "\"args\"",
            "\"env\"",
            "\"url\"",
            "\"npx\"",
            "\"node\"",
            "\"a\"",
            " ",
            "\n",
            "\u{e9}",
            "\\ud800",
            "{\"a\":",
            "[1,2",
            "\u{feff}",
        ];
        let n = 1 + self.below(50);
        (0..n)
            .map(|_| TOKENS[self.below(TOKENS.len())])
            .collect::<Vec<_>>()
            .concat()
    }
}

fn load(dir: &std::path::Path, name: &str, body: &[u8]) -> Result<McpPool> {
    let path = dir.join(name);
    std::fs::write(&path, body).unwrap();
    McpPool::from_config_file(path.to_str().unwrap())
}

const VALID: &str = r#"{"mcpServers":{"alpha":{"command":"npx","args":["-y","example-server"],"env":{"EXAMPLE_KEY":"fake-value-0000"}},"beta":{"url":"ws://example.com/mcp"}}}"#;

#[test]
fn servers_file_valid_loads_both_servers() {
    let dir = tempfile::tempdir().unwrap();
    let pool = load(dir.path(), "ok.json", VALID.as_bytes()).unwrap();
    let mut names = pool.list_mcps();
    names.sort();
    assert_eq!(names, vec!["alpha".to_string(), "beta".to_string()]);
}

#[test]
fn servers_file_random_garbage_never_panics() {
    let dir = tempfile::tempdir().unwrap();
    let mut rng = Rng::new(0xA7C0_0001);
    for i in 0..300 {
        let body: Vec<u8> = match i % 4 {
            0 => rng.text_in(1, 2000).into_bytes(),
            1 => rng.soup().into_bytes(),
            2 => rng.bytes_in(1, 2000),
            _ => format!("{{\"mcpServers\":{{\"a\":{}}}}}", rng.soup()).into_bytes(),
        };
        let path = dir.path().to_path_buf();
        guarded(&format!("servers file garbage #{i}"), move || {
            let _ = load(&path, &format!("g{i}.json"), &body);
        });
    }
}

#[test]
fn servers_file_deep_nesting_never_overflows_the_stack() {
    let dir = tempfile::tempdir().unwrap();
    for depth in [200usize, 5_000, 100_000] {
        let body = format!("{{\"mcpServers\":{{\"a\":{}}}}}", "[".repeat(depth));
        let path = dir.path().to_path_buf();
        guarded(&format!("servers file nesting {depth}"), move || {
            let _ = load(&path, "deep.json", body.as_bytes());
        });
    }
}

#[test]
fn servers_file_cut_short_is_never_accepted() {
    let dir = tempfile::tempdir().unwrap();
    for (i, _) in VALID.char_indices() {
        let body = VALID[..i].to_string();
        let path = dir.path().to_path_buf();
        guarded(&format!("servers file cut at {i}"), move || {
            assert!(
                load(&path, "cut.json", body.as_bytes()).is_err(),
                "a servers file cut at byte {} was accepted",
                body.len()
            );
        });
    }
}

#[test]
fn servers_file_that_is_not_text_or_is_empty_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    assert!(load(dir.path(), "empty.json", b"").is_err());
    assert!(load(dir.path(), "blank.json", b" \n\t").is_err());
    let mut rng = Rng::new(0xA7C0_0002);
    for i in 0..20 {
        let mut bytes = rng.bytes_in(32, 2000);
        bytes[0] = 0xff;
        assert!(load(dir.path(), &format!("bin{i}.json"), &bytes).is_err());
    }
}

/// A servers file whose shape is wrong must say so. Today a top-level array, number or string,
/// a missing `mcpServers` key and a `mcpServers` that is not an object all load as an empty
/// pool with no notice, so a user who misspelt the key believes the servers are configured.
#[test]
#[ignore = "finding: a servers file of the wrong shape loads as an empty pool without a notice"]
fn finding_wrong_shape_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let mut silent = Vec::new();
    for (i, body) in [
        "[]",
        "null",
        "42",
        "\"servers\"",
        "{}",
        r#"{"mcpservers":{"a":{"command":"npx"}}}"#,
        r#"{"mcpServers":[]}"#,
        r#"{"mcpServers":"a"}"#,
        r#"{"mcpServers":null}"#,
    ]
    .iter()
    .enumerate()
    {
        if let Ok(pool) = load(dir.path(), &format!("shape{i}.json"), body.as_bytes()) {
            if pool.notices().is_empty() {
                silent.push(*body);
            }
        }
    }
    assert!(silent.is_empty(), "loaded silently: {silent:?}");
}

/// Two servers with the same name: the last one silently wins while the user reads the first.
#[test]
#[ignore = "finding: a repeated server name or setting in the servers file is not reported"]
fn finding_duplicate_server_name_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let mut silent = Vec::new();
    for (i, body) in [
        r#"{"mcpServers":{"a":{"command":"npx"},"a":{"command":"node"}}}"#,
        r#"{"mcpServers":{"a":{"command":"npx","command":"node"}}}"#,
        r#"{"mcpServers":{"a":{"command":"npx"}},"mcpServers":{"b":{"command":"node"}}}"#,
    ]
    .iter()
    .enumerate()
    {
        if let Ok(pool) = load(dir.path(), &format!("dup{i}.json"), body.as_bytes()) {
            if pool.notices().is_empty() {
                silent.push(*body);
            }
        }
    }
    assert!(silent.is_empty(), "loaded silently: {silent:?}");
}

// ───────────────────────────── upstream reply lines ─────────────────────────────

#[tokio::test]
async fn upstream_reply_random_bytes_never_panic_or_hang() {
    let mut rng = Rng::new(0xA7C0_0003);
    for i in 0..300 {
        let mut data = rng.bytes_in(0, 400);
        for b in data.iter_mut() {
            if *b % 9 == 0 {
                *b = b'\n';
            }
        }
        let max = rng.below(64);
        let cap = 1 + rng.below(16);
        let request = rng.soup();
        let out = tokio::time::timeout(Duration::from_secs(10), async {
            let mut r = BufReader::with_capacity(cap, &data[..]);
            let mut lines = Vec::new();
            for _ in 0..=data.len() {
                let line = read_upstream_line(&mut r, max, &request).await.unwrap();
                if line.is_empty() && r.buffer().is_empty() {
                    break;
                }
                lines.push(line);
            }
            lines
        })
        .await
        .unwrap_or_else(|_| panic!("case #{i} hung"));
        // A reply that was too long is always a JSON-RPC error with a null or request id.
        for l in out {
            if l.contains("Response too large") {
                let v: serde_json::Value = serde_json::from_str(&l).expect("the error is JSON");
                assert_eq!(v["error"]["code"], -32600);
            }
        }
    }
}

/// An upstream server that dies in the middle of a reply must not have the cut text passed on
/// to the client as the reply, and an upstream that closes without a reply must not turn into
/// an empty reply. Today `read_upstream_line` returns whatever it had read when the stream
/// ended, so the client receives half of a JSON document.
#[tokio::test]
#[ignore = "finding: a reply cut by the end of the stream is returned as if it were complete"]
async fn finding_reply_cut_by_eof_is_not_passed_on() {
    let reply =
        r#"{"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"example"}]}}"#;
    let request = r#"{"jsonrpc":"2.0","id":7,"method":"tools/call"}"#;
    let mut passed_on = Vec::new();
    for (i, _) in reply.char_indices() {
        let cut = &reply.as_bytes()[..i];
        let mut r = BufReader::new(cut);
        if let Ok(text) = read_upstream_line(&mut r, 1024, request).await {
            if serde_json::from_str::<serde_json::Value>(&text).is_err() {
                passed_on.push(i);
            }
        }
    }
    assert!(
        passed_on.is_empty(),
        "cuts at these byte offsets came back as text that is not JSON: {passed_on:?}"
    );
}

impl Rng {
    /// `base` plus a random number of bytes below `extra`.
    fn bytes_in(&mut self, base: usize, extra: usize) -> Vec<u8> {
        let n = base + self.below(extra);
        self.bytes(n)
    }
    fn text_in(&mut self, base: usize, extra: usize) -> String {
        let n = base + self.below(extra);
        self.text(n)
    }
}
