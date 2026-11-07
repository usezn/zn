//! End-to-end tests that start the real `zn start` binary.
//!
//! The stdio gateway is a filter: every JSON-RPC line on its stdin comes out on its stdout either
//! scrubbed (what would go on to the tool server) or replaced by a JSON-RPC error (what goes back
//! to the agent). The harness plays both neighbours over real sockets: a relay thread reads the
//! gateway's stdout and sends every frame that is not an error to a mock upstream listening on
//! 127.0.0.1, and every error frame to the "client" side. A frame that never shows up at the mock
//! upstream was never forwarded.
//!
//! Only fake values are used (`example.com`, obviously fake keys). Waits are polls with bounded
//! timeouts, and the gateway child is killed when its handle is dropped.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// How long one expected frame may take to arrive.
const STEP: Duration = Duration::from_secs(30);
/// How long the gateway may take to start answering on its management port.
const BOOT: Duration = Duration::from_secs(120);
/// The management API key the test gateway runs with (fake). The management API always asks for a
/// key, because the tenant store is always on.
const API_KEY: &str = "e2e-example-key-not-real-0001";

fn workdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("zn-e2e-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn zn_command(dir: &Path) -> Command {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_zn"));
    cmd.current_dir(dir)
        .env("ZN_FAST_BOOT", "1")
        .env("RUST_BACKTRACE", "0")
        // No MCP server list and no credentials from the machine running the test.
        .env("HOME", dir)
        .env("USERPROFILE", dir)
        .env_remove("ZN_API_KEY")
        .env_remove("ZN_JWT_SECRET")
        .env_remove("ZN_MCP_WS_TOKEN")
        .env_remove("ZN_DB_KEY")
        .env_remove("ZN_ENV")
        .env_remove("ZN_PORT");
    cmd
}

/// How many times a test starts zn on a new port when the one it picked was taken in between.
const PORT_ATTEMPTS: u32 = 5;

fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

/// `GET path` over a plain socket, with the API key when given: (status, body).
fn http_get(port: u16, path: &str, key: Option<&str>) -> std::io::Result<(u16, String)> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let key_header = key
        .map(|k| format!("X-API-Key: {k}\r\n"))
        .unwrap_or_default();
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: localhost\r\n{key_header}Connection: close\r\n\r\n"
    )?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let text = String::from_utf8_lossy(&raw).to_string();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| std::io::Error::other(format!("no status line in {text:?}")))?;
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    Ok((status, body))
}

/// A running gateway with a mock upstream behind it. Dropping it kills the process.
struct Gateway {
    child: Child,
    stdin: Option<ChildStdin>,
    port: u16,
    /// Frames the mock upstream received, in order.
    upstream: Receiver<String>,
    /// Error frames the gateway sent back towards the agent.
    client: Receiver<Value>,
    stderr: Arc<Mutex<String>>,
    /// Non-empty stdout lines that are not JSON-RPC frames (log or banner text).
    stray_stdout: Arc<Mutex<Vec<String>>>,
    /// The thread draining stderr; joined before the captured text is read after an exit.
    stderr_thread: Option<thread::JoinHandle<()>>,
    dir: PathBuf,
}

impl Gateway {
    fn start(name: &str) -> Gateway {
        Gateway::start_with(name, |_| {}, &[])
    }

    /// Like `start`, with a change to the generated `zn.json`.
    fn start_with(name: &str, tweak: fn(&mut Value), env: &[(&str, &str)]) -> Gateway {
        let dir = workdir(name);
        let status = zn_command(&dir)
            .arg("init")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("run zn init");
        assert!(status.success(), "zn init failed: {status:?}");

        // free_port() releases the port before zn binds it, so a test running in parallel can take it first:
        // zn then exits with "already in use". Try again with a new port a few times.
        for attempt in 1..=PORT_ATTEMPTS {
            let mut gateway = Gateway::launch(&dir, tweak, env);
            match gateway.wait_until_ready() {
                Ok(()) => return gateway,
                Err(e) if attempt < PORT_ATTEMPTS => {
                    eprintln!("zn lost its port at boot (attempt {attempt}): {e}");
                    gateway.dir = PathBuf::new(); // keep the work directory for the next attempt
                }
                Err(e) => panic!("zn lost its port {PORT_ATTEMPTS} times: {e}"),
            }
        }
        unreachable!()
    }

    /// One start of the gateway on a fresh port, with its mock upstream and relay threads.
    fn launch(dir: &Path, tweak: fn(&mut Value), env: &[(&str, &str)]) -> Gateway {
        let dir = dir.to_path_buf();
        let port = free_port();
        let policies = dir.join("policies");
        std::fs::create_dir_all(&policies).unwrap();
        let path = dir.join("zn.json");
        let mut config: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        config["server"]["port"] = json!(port);
        config["server"]["bind_address"] = json!("127.0.0.1");
        config["security"]["rate_limit_per_minute"] = json!(6000);
        config["engine"]["policy_dir"] = json!(policies.to_string_lossy());
        tweak(&mut config);
        std::fs::write(&path, config.to_string()).unwrap();

        // Mock upstream: accepts the relay's connection and hands every line to the test.
        let upstream_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_addr = upstream_listener.local_addr().unwrap();
        let (upstream_tx, upstream) = mpsc::channel::<String>();
        thread::spawn(move || {
            if let Ok((stream, _)) = upstream_listener.accept() {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    if upstream_tx.send(line).is_err() {
                        break;
                    }
                }
            }
        });

        let mut child = zn_command(&dir)
            .arg("start")
            .env("ZN_API_KEY", API_KEY)
            .envs(env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start zn");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let stderr_pipe = child.stderr.take().unwrap();

        // Keep stderr drained (a full pipe would stall the gateway) and available for failures.
        let stderr = Arc::new(Mutex::new(String::new()));
        let stderr_sink = Arc::clone(&stderr);
        let stderr_thread = thread::spawn(move || {
            for line in BufReader::new(stderr_pipe).lines().map_while(Result::ok) {
                let mut sink = stderr_sink.lock().unwrap();
                if sink.len() < 64 * 1024 {
                    sink.push_str(&line);
                    sink.push('\n');
                }
            }
        });

        // Relay: JSON-RPC errors go back to the client side, every other frame goes upstream.
        let stray_stdout = Arc::new(Mutex::new(Vec::<String>::new()));
        let stray_sink = Arc::clone(&stray_stdout);
        let (client_tx, client) = mpsc::channel::<Value>();
        let mut to_upstream = TcpStream::connect(upstream_addr).expect("connect mock upstream");
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                    stray_sink.lock().unwrap().push(line);
                    continue;
                };
                if frame.get("error").is_some() {
                    if client_tx.send(frame).is_err() {
                        break;
                    }
                } else if writeln!(to_upstream, "{line}").is_err() || to_upstream.flush().is_err() {
                    break;
                }
            }
        });

        Gateway {
            child,
            stdin,
            port,
            upstream,
            client,
            stderr,
            stray_stdout,
            stderr_thread: Some(stderr_thread),
            dir,
        }
    }

    /// Ok once the health route answers. Err only when zn exited because its port was taken (the caller retries);
    /// any other early exit or a timeout fails the test.
    fn wait_until_ready(&mut self) -> Result<(), String> {
        let deadline = Instant::now() + BOOT;
        loop {
            self.check_exit()?;
            let last = http_get(self.port, "/api/v1/health", Some(API_KEY));
            if let Ok((200, _)) = last {
                // The 200 may have come from another test's gateway that owns this port. If our child has
                // exited since, that is a lost port (retry), not a ready gateway.
                self.check_exit()?;
                return Ok(());
            }
            assert!(
                Instant::now() < deadline,
                "zn was not ready within {BOOT:?} (last health answer: {last:?}): {}",
                self.stderr_text()
            );
            thread::sleep(Duration::from_millis(100));
        }
    }

    /// Ok while the child runs. Err when it exited because its port was taken (the caller retries); any
    /// other exit fails the test. The stderr drain is joined first, so the text is complete.
    fn check_exit(&mut self) -> Result<(), String> {
        let Some(status) = self.child.try_wait().unwrap() else {
            return Ok(());
        };
        if let Some(drain) = self.stderr_thread.take() {
            let _ = drain.join();
        }
        let text = self.stderr_text();
        if text.contains(&format!("Port {} is already in use", self.port)) {
            return Err(format!("port {} taken ({status:?})", self.port));
        }
        panic!("zn exited early ({status:?}): {text}");
    }

    fn stderr_text(&self) -> String {
        self.stderr.lock().unwrap().clone()
    }

    /// Send one JSON-RPC frame to the gateway as a line on its stdin.
    fn send(&mut self, frame: &Value) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        writeln!(stdin, "{frame}").expect("write to zn stdin");
        stdin.flush().expect("flush zn stdin");
    }

    /// The next frame the mock upstream received.
    fn next_upstream(&self) -> Value {
        let line = self
            .upstream
            .recv_timeout(STEP)
            .unwrap_or_else(|e| panic!("no frame at the upstream ({e}): {}", self.stderr_text()));
        serde_json::from_str(&line)
            .unwrap_or_else(|e| panic!("upstream got non-JSON {line:?}: {e}"))
    }

    /// The next error frame the gateway sent back to the agent.
    fn next_client_error(&self) -> Value {
        self.client.recv_timeout(STEP).unwrap_or_else(|e| {
            panic!(
                "no error frame for the client ({e}): {}",
                self.stderr_text()
            )
        })
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn a_request_with_a_fake_secret_reaches_the_upstream_scrubbed() {
    let mut gw = Gateway::start("scrub");

    // A frame that is not a tool call is passed on scrubbed.
    gw.send(&json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "notifications/message",
        "params": {"text": "contact alice@example.com with api_key=AbCd1234EfGh5678 today"}
    }));
    let frame = gw.next_upstream();
    let text = frame.to_string();
    assert_eq!(frame["id"], json!(1));
    assert_eq!(frame["method"], json!("notifications/message"));
    assert!(
        !text.contains("AbCd1234EfGh5678"),
        "secret reached upstream: {text}"
    );
    assert!(
        !text.contains("alice@example.com"),
        "email reached upstream: {text}"
    );
    assert!(text.contains("[SECRET_REDACTED]"), "{text}");
    assert!(text.contains("[EMAIL_REDACTED]"), "{text}");
    assert!(text.contains("contact") && text.contains("today"), "{text}");

    // An allowed tool call is forwarded scrubbed as well.
    gw.send(&json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": "get_weather",
            "arguments": {"city": "Madrid", "password": "hunter2-example-not-real"}
        }
    }));
    let frame = gw.next_upstream();
    let text = frame.to_string();
    assert_eq!(frame["id"], json!(2));
    assert_eq!(frame["params"]["name"], json!("get_weather"));
    assert_eq!(frame["params"]["arguments"]["city"], json!("Madrid"));
    assert!(
        !text.contains("hunter2-example-not-real"),
        "secret reached upstream: {text}"
    );
    assert!(text.contains("[SECRET_REDACTED]"), "{text}");
}

#[test]
fn a_denied_tool_call_gets_a_jsonrpc_error_and_never_reaches_the_upstream() {
    let mut gw = Gateway::start("deny");

    gw.send(&json!({
        "jsonrpc": "2.0",
        "id": 7,
        "method": "tools/call",
        "params": {"name": "shutdown", "arguments": {"reason": "denied-call-marker"}}
    }));
    let error = gw.next_client_error();
    assert_eq!(error["jsonrpc"], json!("2.0"));
    assert_eq!(error["id"], json!(7));
    assert_eq!(error["error"]["code"], json!(-32001), "{error}");
    let message = error["error"]["message"].as_str().unwrap_or_default();
    assert!(message.contains("Restricted command"), "{error}");

    // The gateway handles frames in order, so once the sentinel is out, the denied call is
    // either already forwarded or never will be.
    gw.send(&json!({"jsonrpc": "2.0", "id": 999, "method": "ping"}));
    let mut seen = Vec::new();
    loop {
        let frame = gw.next_upstream();
        let done = frame["id"] == json!(999);
        seen.push(frame.to_string());
        if done {
            break;
        }
    }
    assert_eq!(seen.len(), 1, "unexpected frames upstream: {seen:?}");
    assert!(
        seen.iter()
            .all(|f| !f.contains("denied-call-marker") && !f.contains("shutdown")),
        "the denied call reached the upstream: {seen:?}"
    );
    // The denied call produced exactly one error and the sentinel none.
    assert!(
        gw.client.try_recv().is_err(),
        "extra error frame for the client"
    );
}

#[test]
fn the_health_route_answers() {
    let gw = Gateway::start("health");
    let (status, body) = http_get(gw.port, "/api/v1/health", Some(API_KEY)).expect("GET health");
    assert_eq!(status, 200);
    assert_eq!(body.trim(), "OK");
    // Without the key the management API refuses, and a wrong key does not help.
    let (status, _) = http_get(gw.port, "/api/v1/health", None).expect("GET health, no key");
    assert_eq!(status, 401);
    let (status, _) = http_get(gw.port, "/api/v1/health", Some("wrong-key-0000")).expect("GET");
    assert_eq!(status, 401);
    // A route that does not exist is a 404, not a hang or a crash.
    let (status, _) =
        http_get(gw.port, "/api/v1/no-such-route", Some(API_KEY)).expect("GET unknown");
    assert_eq!(status, 404);
}

/// Run `zn start` that is expected to fail and return (exit code, stdout + stderr).
fn run_start_expecting_exit(dir: &Path, extra_env: &[(&str, &str)]) -> (Option<i32>, String) {
    let mut cmd = zn_command(dir);
    cmd.arg("start")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("start zn");
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let out_reader = thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    let err_reader = thread::spawn(move || {
        let mut s = String::new();
        let _ = err.read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + STEP;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("zn did not exit on its own within {STEP:?}");
        }
        thread::sleep(Duration::from_millis(50));
    };
    let text = format!(
        "{}{}",
        out_reader.join().unwrap(),
        err_reader.join().unwrap()
    );
    (status.code(), text)
}

#[test]
fn an_invalid_config_exits_non_zero_with_a_plain_message() {
    let dir = workdir("bad-config");
    std::fs::write(
        dir.join("zn.json"),
        r#"{"server": {"port": "not-a-number"}}"#,
    )
    .unwrap();
    let (code, text) = run_start_expecting_exit(&dir, &[]);
    assert_eq!(code, Some(1), "expected a normal error exit: {text}");
    assert!(
        text.contains("zn.json"),
        "the message should name the file: {text}"
    );
    assert!(!text.contains("panicked"), "{text}");

    // A file that is not JSON at all.
    std::fs::write(dir.join("zn.json"), "this is not json").unwrap();
    let (code, text) = run_start_expecting_exit(&dir, &[]);
    assert_eq!(code, Some(1), "{text}");
    assert!(text.contains("zn.json"), "{text}");
    assert!(!text.contains("panicked"), "{text}");

    // A valid file with a value the validator refuses: a JWT secret that is too short.
    std::fs::write(dir.join("zn.json"), "{}").unwrap();
    let (code, text) = run_start_expecting_exit(&dir, &[("ZN_JWT_SECRET", "too-short")]);
    assert_eq!(code, Some(1), "{text}");
    assert!(text.contains("ZN_JWT_SECRET"), "{text}");
    assert!(text.contains("at least"), "{text}");
    assert!(!text.contains("panicked"), "{text}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Fake values of every kind the gateway knows, in one call.
const FAKE_VALUES: &[&str] = &[
    concat!("AK", "IAIOSFODNN7EXAMPLE"),
    concat!("gh", "p_0123456789abcdefghijABCDEFGHIJ012345"),
    // Split so the source holds no token-shaped literal.
    concat!("sk_", "live_EXAMPLEEXAMPLE0123456789"),
    concat!("xo", "xb-123456789012-example0123456789"),
    "GB82 WEST 1234 5698 7654 32",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJl",
    "jane.doe@example.com",
    "4111 1111 1111 1111",
];

/// Every text field of every audit row, payload decrypted, as one text (empty while there is no row yet).
fn audit_dump(dir: &Path, key: &str) -> String {
    let path = dir.join("zn.db");
    if !path.exists() {
        return String::new();
    }
    let Ok(vault) = zn::audit::AuditVault::new(&path.to_string_lossy(), Some(key)) else {
        return String::new();
    };
    let Ok(rows) = vault.get_recent(100) else {
        return String::new();
    };
    rows.iter()
        .map(|r| {
            format!(
                "{}|{}|{}|{}|{}|{}",
                r.tool_name,
                r.status,
                r.policy_match.clone().unwrap_or_default(),
                r.payload.clone().unwrap_or_default(),
                r.agent_id.clone().unwrap_or_default(),
                r.nearest_neighbor.clone().unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join(
            "
",
        )
}

#[test]
fn logs_and_audit_rows_never_hold_secrets_and_stdout_has_no_logs() {
    const DB_KEY: &str = "example-db-key-not-real-0002";
    let mut gw = Gateway::start_with(
        "logredact",
        |c| {
            c["audit"]["store_payloads"] = json!(true);
        },
        &[("ZN_DB_KEY", DB_KEY)],
    );
    let tool = concat!("no_such_gh", "p_0123456789abcdefghijABCDEFGHIJ012345");
    gw.send(&json!({
        "jsonrpc": "2.0",
        "id": 7,
        "method": "tools/call",
        "params": {
            "name": tool,
            "arguments": {
                "note": format!("values: {}", FAKE_VALUES.join(" ; ")),
                "password": "hunter2-example-not-real"
            }
        }
    }));
    // Forwarding is unchanged: the call reaches the upstream with its arguments; the cloud,
    // code-host and chat values are still in it (only what the forwarding scrubber knows is masked).
    let frame = gw.next_upstream();
    let fwd = frame.to_string();
    assert_eq!(frame["params"]["name"], json!(tool));
    for kept in [
        concat!("AK", "IAIOSFODNN7EXAMPLE"),
        concat!("gh", "p_0123456789abcdefghijABCDEFGHIJ012345"),
        concat!("xo", "xb-123456789012"),
    ] {
        assert!(
            fwd.contains(kept),
            "forwarding changed, {kept} missing: {fwd}"
        );
    }

    // Wait for the audit row, then give the logger a moment to flush.
    let deadline = Instant::now() + STEP;
    let dump = loop {
        let d = audit_dump(&gw.dir, DB_KEY);
        if !d.is_empty() {
            break d;
        }
        assert!(
            Instant::now() < deadline,
            "no audit row: {}",
            gw.stderr_text()
        );
        thread::sleep(Duration::from_millis(100));
    };
    thread::sleep(Duration::from_millis(500));
    let stderr = gw.stderr_text();
    let stray = gw.stray_stdout.lock().unwrap().join("\n");

    let cores = FAKE_VALUES.iter().copied().chain([
        "ghp_0123",
        "GB82WEST",
        "4111111111111111",
        "eyJhbGci",
        "hunter2-example-not-real",
    ]);
    for v in cores {
        assert!(!stderr.contains(v), "{v} in stderr: {stderr}");
        assert!(!dump.contains(v), "{v} in the audit database: {dump}");
    }
    assert!(
        stderr.contains("Tool call detected"),
        "the call was not logged: {stderr}"
    );
    assert!(stray.is_empty(), "log text on stdout: {stray}");
}
