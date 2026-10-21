//! `zn start` must refuse `security.rate_limit_per_minute = 0` with a normal
//! error, not abort the process.

use std::path::PathBuf;
use std::process::{Command, Stdio};

fn workdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("zn-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn zn(dir: &PathBuf, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_zn"))
        .args(args)
        .current_dir(dir)
        .env("ZN_FAST_BOOT", "1")
        .env("RUST_BACKTRACE", "0")
        .stdin(Stdio::null())
        .output()
        .expect("run zn")
}

#[test]
fn start_with_zero_rate_limit_exits_with_a_clear_error() {
    let dir = workdir("rate-limit-zero");
    assert!(zn(&dir, &["init"]).status.success(), "zn init failed");
    let path = dir.join("zn.json");
    let mut config: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    config["security"]["rate_limit_per_minute"] = serde_json::json!(0);
    std::fs::write(&path, config.to_string()).unwrap();

    let out = zn(&dir, &["start"]);
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(
        out.status.code(),
        Some(1),
        "expected a normal error exit: {text}"
    );
    assert!(text.contains("rate_limit_per_minute"), "{text}");
    assert!(text.contains("at least 1"), "{text}");
    assert!(!text.contains("panicked"), "{text}");
}
