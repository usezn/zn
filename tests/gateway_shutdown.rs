//! Stopping the gateway on a signal (Unix only: the tests send real signals).
//!
//! - `zn start` exits with 143 after SIGTERM and 130 after SIGINT, and the audit entry of the
//!   last request it answered is in the database.
//! - Stopping the MCP server pool kills a stdio server that is running.

#![cfg(unix)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn workdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("zn-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn signal(name: &str, pid: u32) {
    let status = Command::new("kill")
        .args([&format!("-{name}"), &pid.to_string()])
        .status()
        .expect("run kill");
    assert!(status.success(), "kill -{name} {pid} failed");
}

fn process_exists(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn wait_for_exit(child: &mut Child, limit: Duration) -> Option<std::process::ExitStatus> {
    let start = Instant::now();
    while start.elapsed() < limit {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

fn audit_rows(db: &Path) -> Vec<String> {
    let conn = rusqlite::Connection::open(db).expect("open audit db");
    let mut stmt = conn
        .prepare("SELECT tool_name FROM audit_logs ORDER BY rowid")
        .unwrap();
    stmt.query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
}

/// Start `zn start`, make it answer one tool call, send it `signal_name`, and check how it ends.
fn stop_with(signal_name: &str, expected_code: i32) {
    let dir = workdir(&format!("signal-{}", signal_name.to_lowercase()));
    let db = dir.join("audit.db");
    let mut child = Command::new(env!("CARGO_BIN_EXE_zn"))
        .args(["--port", "0", "--db-path"])
        .arg(&db)
        .arg("start")
        .current_dir(&dir)
        .env("ZN_FAST_BOOT", "1")
        .env("RUST_BACKTRACE", "0")
        .env("HOME", &dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("start zn");
    let pid = child.id();

    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let request = r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"read_note","arguments":{"path":"notes/todo.txt"}}}"#;
    writeln!(stdin, "{request}").unwrap();
    stdin.flush().unwrap();

    // The startup banner shares stdout; the answer is the first JSON line.
    let mut answer = String::new();
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let mut line = String::new();
        let n = stdout.read_line(&mut line).unwrap();
        assert!(n > 0, "zn closed stdout before answering: {answer}");
        if line.trim_start().starts_with('{') {
            answer = line;
            break;
        }
        assert!(Instant::now() < deadline, "no answer from zn");
    }
    assert!(answer.contains("\"id\":7"), "{answer}");

    // Keep stdin open: only the signal may end the gateway.
    signal(signal_name, pid);
    let status = wait_for_exit(&mut child, Duration::from_secs(20));
    let status = match status {
        Some(s) => s,
        None => {
            let _ = child.kill();
            panic!("zn did not exit after SIG{signal_name}");
        }
    };
    drop(stdin);

    assert_eq!(status.code(), Some(expected_code), "exit status {status:?}");
    let rows = audit_rows(&db);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(
        rows.last().map(String::as_str),
        Some("read_note"),
        "the last answered request must be in the audit log: {rows:?}"
    );
}

#[test]
fn sigterm_stops_the_gateway_with_143_and_keeps_the_last_audit_entry() {
    stop_with("TERM", 143);
}

#[test]
fn sigint_stops_the_gateway_with_130_and_keeps_the_last_audit_entry() {
    stop_with("INT", 130);
}

#[tokio::test]
async fn stopping_the_pool_kills_a_running_stdio_server() {
    use zn::proxy::{McpPool, McpServerConfig};
    use zn::shutdown::stop_children;

    if Command::new("python3").arg("--version").output().is_err() {
        eprintln!("python3 not found: skipping");
        return;
    }
    let dir = workdir("pool-stop");
    let script = dir.join("fake_mcp.py");
    // A stand-in MCP server: it answers one request with its own process id, then waits.
    std::fs::write(
        &script,
        "import os, sys, time\n\
         sys.stdin.readline()\n\
         print('{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"pid\":%d}}' % os.getpid(), flush=True)\n\
         time.sleep(600)\n",
    )
    .unwrap();

    let mut configs = HashMap::new();
    configs.insert(
        "fake".to_string(),
        McpServerConfig {
            command: Some("python3".to_string()),
            args: vec![script.to_string_lossy().to_string()],
            env: HashMap::new(),
            url: None,
        },
    );
    let pool = McpPool::new(configs);
    let response = pool
        .send("fake", r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#, None)
        .await
        .expect("the fake server answers");
    let value: serde_json::Value = serde_json::from_str(&response).unwrap();
    let pid = value["result"]["pid"].as_u64().unwrap() as u32;
    assert!(process_exists(pid), "the server should be running");

    assert!(stop_children(&pool, Duration::from_secs(5)).await);
    let start = Instant::now();
    while process_exists(pid) && start.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        !process_exists(pid),
        "the server must be gone after the stop"
    );
}
