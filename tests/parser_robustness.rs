//! Robustness tests for the parsers of the gateway: the settings file, policy files and their
//! signature files, the audit database reader and the JSON-RPC lines read from stdin.
//!
//! The inputs are harmless: seeded random garbage (printable text, random bytes, JSON-shaped
//! soup, deep nesting) and every truncation of a small valid file. Nothing here is an attack
//! payload. Each case runs in its own thread with a timeout, so a panic or a hang names the
//! case instead of stopping the whole run. The rules:
//!
//! 1. no input may panic or hang a parser;
//! 2. a file that was cut short must never be accepted as if it were complete;
//! 3. bytes that are not a file of the expected kind must be refused, not read as an empty one.
//!
//! A test whose name starts with `finding_` and is `#[ignore]` documents a failure that exists
//! today. Run those with `cargo test --test parser_robustness -- --ignored`.

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use zn::audit::{AuditEntry, AuditVault};
use zn::bounded_line::{read_line_bounded, BoundedLine};
use zn::config::{config_parse_problem, unknown_settings, ZnConfig};
use zn::engine::{ZnEngine, ZnEngineConfig};
use zn::jsonrpc::{validate_jsonrpc, JsonRpcValidation};

/// Longest a single case may take.
const CASE_TIMEOUT: Duration = Duration::from_secs(30);

/// Run one case in its own thread. A panic and a hang both fail with the case name.
fn guarded<T: Send + 'static>(what: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = mpsc::channel();
    let handle = std::thread::Builder::new()
        .name(format!("case-{what}"))
        .spawn(move || {
            let _ = tx.send(f());
        })
        .expect("thread starts");
    match rx.recv_timeout(CASE_TIMEOUT) {
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
    /// Printable ASCII, plus tab and newline.
    fn text(&mut self, n: usize) -> String {
        (0..n)
            .map(|_| match self.below(40) {
                0 => '\n',
                1 => '\t',
                _ => (0x20 + self.below(0x5f)) as u8 as char,
            })
            .collect()
    }
    /// Text that looks like JSON that went wrong: valid tokens in a random order.
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
            "false",
            "0",
            "-1",
            "1e999",
            "1.5e-3",
            "\"name\"",
            "\"method\"",
            "\"params\"",
            "\"arguments\"",
            "\"tools/call\"",
            "\"jsonrpc\"",
            "\"2.0\"",
            "\"id\"",
            "\"server\"",
            "\"port\"",
            "\"security\"",
            "\"audit\"",
            " ",
            "\n",
            "\t",
            "\u{e9}",
            "\\u00e9",
            "\\ud800",
            "{\"a\":",
            "[1,2",
            "\u{feff}",
            "\u{0}",
        ];
        let n = 1 + self.below(60);
        (0..n)
            .map(|_| TOKENS[self.below(TOKENS.len())])
            .collect::<Vec<_>>()
            .concat()
    }
}

/// Every char boundary prefix of `text` that is shorter than the whole text.
fn prefixes(text: &str) -> Vec<String> {
    text.char_indices()
        .map(|(i, _)| text[..i].to_string())
        .collect()
}

// ───────────────────────────── settings file ─────────────────────────────

fn valid_config_text(dir: &Path) -> String {
    let path = dir.join("zn.json");
    ZnConfig::write_init_file(&path).expect("init file is written");
    std::fs::read_to_string(&path).expect("init file is read")
}

#[test]
fn config_random_garbage_never_panics() {
    let mut rng = Rng::new(0xC0FF_EE01);
    for i in 0..400 {
        let input = match i % 4 {
            0 => rng.text_in(1, 2000),
            1 => rng.soup(),
            2 => String::from_utf8_lossy(&rng.bytes_in(1, 2000)).into_owned(),
            _ => format!("{{{}}}", rng.soup()),
        };
        guarded(&format!("config garbage #{i}"), move || {
            let parsed = ZnConfig::parse_text("zn.json", &input);
            let _ = unknown_settings(&input);
            if let Err(e) = &parsed {
                // The message for the user is built from the text of the error.
                assert!(!e.to_string().is_empty());
            }
            if let Ok(config) = parsed {
                let _ = config.validate();
                let _ = config.is_neural_blocking();
                let _ = config.paranoia_threshold_multiplier();
                let _ = config.paranoia_classifier_threshold();
            }
            if let Err(e) = serde_json::from_str::<ZnConfig>(&input) {
                let _ = config_parse_problem("zn.json", &input, &e);
            }
        });
    }
}

#[test]
fn config_deep_nesting_never_overflows_the_stack() {
    for depth in [200usize, 5_000, 100_000] {
        for open in ["[", "{\"a\":", "{\"security\":"] {
            let text = open.repeat(depth);
            guarded(&format!("config nesting {depth} of {open}"), move || {
                let _ = ZnConfig::parse_text("zn.json", &text);
                let _ = unknown_settings(&text);
                if let Err(e) = serde_json::from_str::<ZnConfig>(&text) {
                    let _ = config_parse_problem("zn.json", &text, &e);
                }
            });
        }
    }
}

#[test]
fn config_cut_short_is_never_accepted() {
    let dir = tempfile::tempdir().unwrap();
    let valid = valid_config_text(dir.path());
    assert!(
        ZnConfig::parse_text("zn.json", &valid).is_ok(),
        "the base file is valid"
    );
    let whole = valid.trim_end().to_string();
    for (i, prefix) in prefixes(&valid).into_iter().enumerate() {
        if prefix.trim_end() == whole {
            continue;
        }
        let shown = prefix.clone();
        guarded(
            &format!("config prefix of {} bytes", shown.len()),
            move || {
                assert!(
                    ZnConfig::parse_text("zn.json", &prefix).is_err(),
                    "a settings file cut at byte {} was accepted",
                    prefix.len()
                );
            },
        );
        // The same through the file loader, on a sample of the cut points.
        if i % 9 == 0 {
            let path = dir.path().join(format!("cut-{i}.json"));
            std::fs::write(&path, &valid.as_bytes()[..shown.len()]).unwrap();
            guarded(&format!("config file cut at {}", shown.len()), move || {
                assert!(
                    ZnConfig::load_with_notices(Some(&path)).is_err(),
                    "a settings file cut at byte {} was loaded",
                    shown.len()
                );
            });
        }
    }
}

#[test]
fn config_file_that_is_not_text_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let mut rng = Rng::new(0xC0FF_EE02);
    for i in 0..40 {
        let mut bytes = rng.bytes_in(16, 3000);
        // Not UTF-8 and not JSON: a stray 0xff and 0xfe lead the file.
        bytes[0] = 0xff;
        bytes[1] = 0xfe;
        let path = dir.path().join(format!("binary-{i}.json"));
        std::fs::write(&path, &bytes).unwrap();
        guarded(&format!("config binary file #{i}"), move || {
            assert!(ZnConfig::load_with_notices(Some(&path)).is_err());
        });
    }
    // Empty and whitespace-only files are not a settings file either.
    for (i, body) in ["", " ", "\n\n", "\u{feff}", "null", "\"{}\"", "0", "true"]
        .iter()
        .enumerate()
    {
        let path = dir.path().join(format!("blank-{i}.json"));
        std::fs::write(&path, body).unwrap();
        guarded(&format!("config blank file #{i}"), move || {
            assert!(
                ZnConfig::load_with_notices(Some(&path)).is_err(),
                "a settings file with no object in it was loaded"
            );
        });
    }
}

/// A settings file that is not a JSON object must be refused. serde reads a JSON array as the
/// fields of the struct in order, so `[]` loads as a complete default configuration and a list
/// of values fills the first settings. The JSON-RPC validator already guards against the same
/// behaviour for frames.
#[test]
#[ignore = "finding: a settings file that is a JSON array is accepted"]
fn finding_settings_array_is_refused() {
    let accepted: Vec<&str> = ["[]", "[{}]", "[null]", "[1]", "[{},{}]", "[[],[]]"]
        .into_iter()
        .filter(|body| ZnConfig::parse_text("zn.json", body).is_ok())
        .collect();
    assert!(
        accepted.is_empty(),
        "accepted as a settings file: {accepted:?}"
    );
}

// ───────────────────────────── policy files ─────────────────────────────

/// A valid WebAssembly module: one type, one function, one body. Its section ends are at
/// bytes 14 (type), 18 (function) and 24 (code, the whole file).
const WASM: [u8; 24] = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // header
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type section: () -> ()
    0x03, 0x02, 0x01, 0x00, // function section: one function of type 0
    0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b, // code section: empty body
];

fn engine(signing_public_key: Option<String>) -> ZnEngine {
    ZnEngine::new(ZnEngineConfig {
        gas_limit: 1_000_000,
        memory_limit: 16 * 1024 * 1024,
        timeout_ms: 100,
        allowed_hashes: Vec::new(),
        signing_public_key,
    })
    .expect("the engine starts")
}

#[test]
fn policy_random_garbage_never_panics_and_is_refused() {
    let mut rng = Rng::new(0xC0FF_EE03);
    let e = std::sync::Arc::new(engine(None));
    for i in 0..300 {
        let mut bytes = match i % 3 {
            0 => rng.bytes_in(1, 4000),
            1 => rng.text_in(1, 4000).into_bytes(),
            _ => rng.soup().into_bytes(),
        };
        // Keep the case away from a real module or a text module: neither starts like this.
        bytes.insert(0, 0xfe);
        let e = e.clone();
        guarded(&format!("policy garbage #{i}"), move || {
            assert!(e._load_policy_from_bytes(&bytes, "garbage").is_err());
        });
    }
}

#[test]
fn policy_valid_module_loads() {
    let e = engine(None);
    assert!(e._load_policy_from_bytes(&WASM, "ok").is_ok());
}

#[test]
fn policy_cut_inside_a_section_is_refused() {
    let e = std::sync::Arc::new(engine(None));
    for len in 1..WASM.len() {
        // A cut at the end of the type section is a smaller module that is complete.
        if len == 8 || len == 14 {
            continue;
        }
        let e = e.clone();
        guarded(&format!("policy cut at {len}"), move || {
            assert!(
                e._load_policy_from_bytes(&WASM[..len], "cut").is_err(),
                "a policy module cut at byte {len} of {} was accepted",
                WASM.len()
            );
        });
    }
}

#[test]
fn policy_files_on_disk_cut_short_are_not_registered() {
    let dir = tempfile::tempdir().unwrap();
    for len in 1..WASM.len() {
        if len == 8 || len == 14 {
            continue;
        }
        std::fs::write(dir.path().join(format!("cut-{len}.wasm")), &WASM[..len]).unwrap();
    }
    std::fs::write(dir.path().join("whole.wasm"), WASM).unwrap();
    let path = dir.path().to_path_buf();
    let count = guarded("policy folder load", move || {
        let e = engine(None);
        e.load_all_policies(&path)
            .expect("the folder load itself succeeds");
        let mut names = e.list_policies();
        names.sort();
        names
    });
    assert_eq!(
        count,
        vec!["whole".to_string()],
        "only the whole file is a policy"
    );
}

#[test]
fn policy_install_of_cut_bytes_writes_nothing_and_keeps_the_old_file() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("p.wasm");
    std::fs::write(&target, WASM).unwrap();
    for len in [1usize, 7, 9, 13, 15, 17, 19, 23] {
        let target = target.clone();
        guarded(&format!("policy install cut {len}"), move || {
            let e = engine(None);
            assert!(e.install_policy(&target, &WASM[..len]).is_err());
            assert_eq!(
                std::fs::read(&target).unwrap(),
                WASM,
                "the old policy file changed"
            );
        });
    }
}

#[test]
fn policy_signature_files_that_are_cut_or_garbage_are_refused() {
    use base64::Engine as _;
    use ed25519_dalek::{Signer, SigningKey};

    let sk = SigningKey::from_bytes(&[9u8; 32]);
    let key_hex = hex::encode(sk.verifying_key().to_bytes());
    let good_sig = base64::engine::general_purpose::STANDARD.encode(sk.sign(&WASM).to_bytes());

    // The control case: the whole file with the whole signature loads.
    let dir = tempfile::tempdir().unwrap();
    let wasm = dir.path().join("p.wasm");
    std::fs::write(&wasm, WASM).unwrap();
    std::fs::write(dir.path().join("p.wasm.sig"), &good_sig).unwrap();
    assert!(engine(Some(key_hex.clone()))
        .register_policy_from_file(&wasm)
        .is_ok());

    let mut cases: Vec<(String, Vec<u8>, Vec<u8>)> = Vec::new();
    // A signature file cut at every length.
    for len in 0..good_sig.len() {
        cases.push((
            format!("signature cut at {len}"),
            WASM.to_vec(),
            good_sig.as_bytes()[..len].to_vec(),
        ));
    }
    // A module cut short with the signature of the whole module.
    for len in [0usize, 1, 8, 14, 18, 23] {
        cases.push((
            format!("module cut at {len}, whole signature"),
            WASM[..len].to_vec(),
            good_sig.as_bytes().to_vec(),
        ));
    }
    // Random garbage as the signature.
    let mut rng = Rng::new(0xC0FF_EE04);
    for i in 0..30 {
        cases.push((
            format!("garbage signature #{i}"),
            WASM.to_vec(),
            rng.bytes_in(1, 200),
        ));
        cases.push((
            format!("text signature #{i}"),
            WASM.to_vec(),
            rng.text_in(1, 200).into_bytes(),
        ));
    }
    for (i, (name, wasm_bytes, sig)) in cases.into_iter().enumerate() {
        let case_dir = tempfile::tempdir().unwrap();
        let wasm = case_dir.path().join("p.wasm");
        std::fs::write(&wasm, &wasm_bytes).unwrap();
        std::fs::write(case_dir.path().join("p.wasm.sig"), &sig).unwrap();
        let key_hex = key_hex.clone();
        guarded(&format!("{name} (#{i})"), move || {
            let _keep = &case_dir;
            let e = engine(Some(key_hex));
            assert!(
                e.register_policy_from_file(&wasm).is_err(),
                "{name} was accepted"
            );
            assert_eq!(e.policy_count(), 0);
        });
    }
}

// ───────────────────────────── JSON-RPC lines ─────────────────────────────

const FRAMES: &[&str] = &[
    r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"q":"example.com"}}}"#,
    r#"{"jsonrpc":"2.0","id":"a","method":"tools/call","params":{"name":"search","input":{"q":"example.com"}},"agent_id":"agent-1"}"#,
    r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_file","args":{"path":"/tmp/example.txt"}}}"#,
    r#"{"jsonrpc":"2.0","id":3,"method":"tasks/send","params":{"recipient":"worker","task":{"text":"hello"}}}"#,
    r#"{"jsonrpc":"2.0","id":4,"method":"ping"}"#,
    r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
];

fn is_forwardable(v: &JsonRpcValidation) -> bool {
    !matches!(v, JsonRpcValidation::Error { .. })
}

#[test]
fn jsonrpc_valid_frames_are_accepted() {
    for f in FRAMES {
        assert!(
            is_forwardable(&validate_jsonrpc(f)),
            "valid frame refused: {f}"
        );
    }
}

#[test]
fn jsonrpc_line_cut_short_is_never_forwarded() {
    for frame in FRAMES {
        for prefix in prefixes(frame) {
            let shown = prefix.len();
            guarded(&format!("frame cut at {shown}"), move || {
                let v = validate_jsonrpc(&prefix);
                assert!(
                    !is_forwardable(&v),
                    "a frame cut at byte {} was forwarded: {:?}",
                    prefix.len(),
                    v
                );
            });
        }
    }
}

#[test]
fn jsonrpc_two_frames_or_trailing_text_on_one_line_are_refused() {
    for frame in FRAMES {
        for tail in [*frame, " x", "}", "]", ",", "\u{0}", "\u{feff}", "//", "{}"] {
            let line = format!("{frame}{tail}");
            guarded("jsonrpc trailing", move || {
                assert!(
                    !is_forwardable(&validate_jsonrpc(&line)),
                    "a line with extra text after the frame was forwarded: {line}"
                );
            });
        }
    }
}

#[test]
fn jsonrpc_random_garbage_never_panics() {
    let mut rng = Rng::new(0xC0FF_EE05);
    for i in 0..600 {
        let input = match i % 4 {
            0 => rng.text_in(1, 3000),
            1 => rng.soup(),
            2 => String::from_utf8_lossy(&rng.bytes_in(1, 3000)).into_owned(),
            _ => format!(
                "{{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{}}}",
                rng.soup()
            ),
        };
        guarded(&format!("jsonrpc garbage #{i}"), move || {
            if let JsonRpcValidation::ToolCall {
                tool_name,
                arguments,
                ..
            } = validate_jsonrpc(&input)
            {
                assert!(!tool_name.is_empty());
                assert!(serde_json::from_str::<serde_json::Value>(&arguments).is_ok());
            }
        });
    }
}

#[test]
fn jsonrpc_deep_nesting_never_overflows_the_stack() {
    for depth in [200usize, 5_000, 100_000, 1_000_000] {
        for open in ["[", "{\"a\":"] {
            let inner = open.repeat(depth);
            let line = format!(
                "{{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{{\"name\":\"t\",\"arguments\":{inner}}}}}"
            );
            guarded(&format!("jsonrpc nesting {depth} of {open}"), move || {
                let _ = validate_jsonrpc(&line);
            });
            let bare = open.repeat(depth);
            guarded(
                &format!("jsonrpc bare nesting {depth} of {open}"),
                move || {
                    let _ = validate_jsonrpc(&bare);
                },
            );
        }
    }
}

// ───────────────────────────── stdin line reader ─────────────────────────────

/// What the reader must return for `data` with a limit of `max`, worked out by splitting.
fn expected_lines(data: &[u8], max: usize) -> Vec<BoundedLine> {
    let mut out = Vec::new();
    let mut rest = data;
    while !rest.is_empty() {
        let (line, tail) = match rest.iter().position(|b| *b == b'\n') {
            Some(i) => (&rest[..i], &rest[i + 1..]),
            None => (rest, &rest[rest.len()..]),
        };
        if line.len() > max {
            out.push(BoundedLine::TooLong);
        } else {
            let mut l = line.to_vec();
            if l.last() == Some(&b'\r') {
                l.pop();
            }
            out.push(BoundedLine::Line(String::from_utf8_lossy(&l).into_owned()));
        }
        rest = tail;
    }
    out
}

#[test]
fn bounded_line_matches_a_plain_split_for_random_input_and_chunking() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let mut rng = Rng::new(0xC0FF_EE06);
    for i in 0..400 {
        let n = rng.below(300);
        let mut data = rng.bytes(n);
        for b in data.iter_mut() {
            // Many newlines and carriage returns, so short lines are common.
            match *b % 7 {
                0 => *b = b'\n',
                1 => *b = b'\r',
                _ => {}
            }
        }
        let max = rng.below(40);
        let capacity = 1 + rng.below(16);
        let want = expected_lines(&data, max);
        let got = rt.block_on(async {
            tokio::time::timeout(Duration::from_secs(10), async {
                let mut reader = tokio::io::BufReader::with_capacity(capacity, &data[..]);
                let mut out = Vec::new();
                loop {
                    match read_line_bounded(&mut reader, max).await.unwrap() {
                        BoundedLine::Eof => break,
                        other => out.push(other),
                    }
                    assert!(out.len() <= data.len() + 1, "the reader does not advance");
                }
                out
            })
            .await
            .expect("the reader hung")
        });
        assert_eq!(got, want, "case #{i}, max {max}, buffer {capacity}");
    }
}

// ───────────────────────────── audit database ─────────────────────────────

fn entry(i: usize) -> AuditEntry {
    AuditEntry {
        id: format!("id-{i:04}"),
        timestamp: format!("2026-10-18T00:{:02}:00Z", i % 60),
        event: "TOOL_CALL".into(),
        tool_name: "shell".into(),
        status: if i.is_multiple_of(2) {
            "ALLOWED"
        } else {
            "DENIED"
        }
        .into(),
        policy_match: Some("example-policy".into()),
        payload: Some(format!("example payload number {i}")),
        agent_id: Some("agent-1".into()),
        namespace: None,
        anomaly_score: None,
        nearest_neighbor: None,
        fusion: None,
    }
}

/// A closed audit database with `n` entries, as the bytes of its file.
fn audit_file(dir: &Path, n: usize) -> Vec<u8> {
    let path = dir.join("source.db");
    {
        let vault = AuditVault::new(path.to_str().unwrap(), None).unwrap();
        for i in 0..n {
            vault.log(entry(i)).unwrap();
        }
    }
    std::fs::read(&path).unwrap()
}

#[test]
fn audit_reader_on_a_database_cut_short_never_invents_entries() {
    let dir = tempfile::tempdir().unwrap();
    let whole = audit_file(dir.path(), 60);
    let size = whole.len();
    let mut lens: Vec<usize> = vec![0, 1, 15, 16, 99, 100, 101, 511, 512, 513, 1023, 1024, 4095];
    let mut page = 4096;
    while page < size {
        lens.extend([page - 1, page, page + 1]);
        page += 4096;
    }
    lens.push(size - 1);
    lens.retain(|l| *l < size);
    lens.sort();
    lens.dedup();
    for len in lens {
        let path = dir.path().join(format!("cut-{len}.db"));
        std::fs::write(&path, &whole[..len]).unwrap();
        let outcome = guarded(
            &format!("audit database cut at {len} of {size}"),
            move || {
                let vault = match AuditVault::new(path.to_str().unwrap(), None) {
                    Ok(v) => v,
                    Err(_) => return "refused at open".to_string(),
                };
                let _ = vault.count();
                let _ = vault.stats();
                let _ = vault.get_recent_by_namespace("none", 10);
                match vault.get_recent(1000) {
                    Err(_) => "opened, read refused".to_string(),
                    Ok(rows) => {
                        for r in &rows {
                            let i: usize =
                                r.id.trim_start_matches("id-")
                                    .parse()
                                    .expect("an id we wrote");
                            assert_eq!(
                                r.payload.as_deref(),
                                Some(format!("example payload number {i}").as_str())
                            );
                        }
                        format!("opened, {} of 60 rows read", rows.len())
                    }
                }
            },
        );
        println!("AUDIT-CUT len={len} of {size}: {outcome}");
    }
}

#[test]
fn audit_database_cut_short_is_not_read_as_if_complete() {
    // Every cut that removes rows must either be refused or visibly return fewer rows; it must
    // never come back as the full 60 rows. (A cut of the unused tail of the last page, such as
    // one byte, removes no row: SQLite reads the missing bytes as zeros, so it is not tested.)
    let dir = tempfile::tempdir().unwrap();
    let whole = audit_file(dir.path(), 60);
    let size = whole.len();
    assert!(size > 8192, "the base database has several pages");
    for len in [size - 4096 - 1, size - 8192, 4096 + 100, 4096 + 1, 200] {
        let path = dir.path().join(format!("strict-{len}.db"));
        std::fs::write(&path, &whole[..len]).unwrap();
        guarded(&format!("audit strict cut at {len}"), move || {
            let accepted = match AuditVault::new(path.to_str().unwrap(), None) {
                Ok(v) => v.get_recent(1000).map(|r| r.len()).ok(),
                Err(_) => None,
            };
            assert_ne!(
                accepted,
                Some(60),
                "a database cut at byte {len} of {size} was read as complete"
            );
        });
    }
}

#[test]
fn audit_reader_on_garbage_files_never_panics_and_refuses_them() {
    let dir = tempfile::tempdir().unwrap();
    let mut rng = Rng::new(0xC0FF_EE07);
    for i in 0..60 {
        let bytes = match i % 3 {
            0 => rng.bytes_in(101, 9000),
            1 => rng.text_in(101, 9000).into_bytes(),
            _ => rng.soup().repeat(20).into_bytes(),
        };
        let path = dir.path().join(format!("garbage-{i}.db"));
        std::fs::write(&path, &bytes).unwrap();
        guarded(&format!("audit garbage file #{i}"), move || {
            assert!(
                AuditVault::new(path.to_str().unwrap(), None).is_err(),
                "a file of random bytes was opened as an audit database"
            );
        });
    }
}

#[test]
fn audit_reader_on_a_database_with_garbage_in_the_middle_never_panics() {
    let dir = tempfile::tempdir().unwrap();
    let whole = audit_file(dir.path(), 60);
    let mut rng = Rng::new(0xC0FF_EE08);
    for i in 0..40 {
        let mut bytes = whole.clone();
        // Overwrite a stretch after the header with random bytes.
        let start = 100 + rng.below(bytes.len() - 600);
        let len = 1 + rng.below(500);
        for (k, b) in rng.bytes(len).into_iter().enumerate() {
            bytes[start + k] = b;
        }
        let path = dir.path().join(format!("flip-{i}.db"));
        std::fs::write(&path, &bytes).unwrap();
        guarded(&format!("audit damaged database #{i}"), move || {
            if let Ok(vault) = AuditVault::new(path.to_str().unwrap(), None) {
                let _ = vault.count();
                let _ = vault.stats();
                let _ = vault.get_recent(1000);
                let _ = vault.get_recent_by_namespace("none", 10);
            }
        });
    }
}

#[test]
fn audit_reader_on_rows_with_odd_values_never_panics() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("odd.db");
    let path_str = path.to_str().unwrap().to_string();
    drop(AuditVault::new(&path_str, None).unwrap());
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        let big = "x".repeat(2_000_000);
        let cols = "id, timestamp, event, tool_name, status, payload, anomaly_score, fusion";
        let sql = format!(
            "INSERT INTO audit_logs ({cols}) VALUES ('integer-timestamp', 42, 'e', 't', 'ok', 'p', 0.5, '{{bad');
             INSERT INTO audit_logs ({cols}) VALUES ('blob-status', '2026-10-18T00:00:00Z', 'e', 't', X'FFFE00', 'p', 0.5, '[]');
             INSERT INTO audit_logs ({cols}) VALUES ('text-score', '2026-10-18T00:00:01Z', 'e', 't', 'ok', 'p', 'abc', '{{}}');
             INSERT INTO audit_logs ({cols}) VALUES ('huge-payload', '2026-10-18T00:00:02Z', 'e', 't', 'ok', '{big}', 0.5, '');
             INSERT INTO audit_logs ({cols}) VALUES ('empty-strings', '', '', '', '', NULL, NULL, 'null');"
        );
        conn.execute_batch(&sql).unwrap();
    }
    guarded("audit odd rows", move || {
        let vault = AuditVault::new(&path_str, None).expect("opens");
        let _ = vault.count();
        let _ = vault.stats();
        let _ = vault.get_recent(100);
        let _ = vault.get_recent_by_namespace("none", 100);
    });
}

/// One row with a value of the wrong type (a blob where text belongs) must not hide every other
/// row of the log. If the reader fails as a whole, an operator reading the audit log sees
/// nothing at all.
#[test]
#[ignore = "finding: one malformed row makes get_recent fail for all rows"]
fn finding_audit_one_bad_row_hides_the_rest_of_the_log() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("one-bad.db");
    let path_str = path.to_str().unwrap().to_string();
    {
        let vault = AuditVault::new(&path_str, None).unwrap();
        for i in 0..5 {
            vault.log(entry(i)).unwrap();
        }
    }
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute(
            "INSERT INTO audit_logs (id, timestamp, event, tool_name, status) VALUES ('bad', 'x', 'e', 't', X'FFFE00')",
            [],
        )
        .unwrap();
    }
    let rows = guarded("audit one bad row", move || {
        AuditVault::new(&path_str, None).unwrap().get_recent(100)
    });
    let rows = rows.expect("the readable rows are still returned");
    assert!(rows.len() >= 5);
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
