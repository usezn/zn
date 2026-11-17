//! Settings that used to abort `zn start` with a panic or an overflow must stop it with a
//! normal error (exit code 1, a message that names the setting, no "panicked").

use std::path::PathBuf;
use std::process::{Command, Stdio};

fn workdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("zn-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn zn(
    dir: &PathBuf,
    args: &[&str],
    envs: &[(&str, &str)],
    fast_boot: bool,
) -> (Option<i32>, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_zn"));
    cmd.args(args)
        .current_dir(dir)
        .env("RUST_BACKTRACE", "0")
        .stdin(Stdio::null());
    if fast_boot {
        cmd.env("ZN_FAST_BOOT", "1");
    } else {
        cmd.env_remove("ZN_FAST_BOOT");
    }
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let out = cmd.output().expect("run zn");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    (out.status.code(), text)
}

/// A fresh folder with a `zn.json` where `section.key` is `value`.
fn with_setting(name: &str, section: &str, key: &str, value: serde_json::Value) -> PathBuf {
    let dir = workdir(name);
    assert_eq!(zn(&dir, &["init"], &[], true).0, Some(0), "zn init failed");
    let path = dir.join("zn.json");
    let mut config: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    config[section][key] = value;
    std::fs::write(&path, config.to_string()).unwrap();
    dir
}

fn assert_normal_error(result: (Option<i32>, String), needles: &[&str]) {
    let (code, text) = result;
    assert_eq!(code, Some(1), "expected a normal error exit: {text}");
    for n in needles {
        assert!(text.contains(n), "missing {n:?}: {text}");
    }
    assert!(!text.contains("panicked"), "{text}");
}

#[test]
fn zero_channel_capacity_is_a_normal_error() {
    let dir = with_setting("chan0", "server", "channel_capacity", serde_json::json!(0));
    let r = zn(&dir, &["start"], &[], true);
    let _ = std::fs::remove_dir_all(&dir);
    assert_normal_error(r, &["server.channel_capacity", "1 to 1000000"]);
}

#[test]
fn huge_channel_capacity_is_a_normal_error() {
    let dir = with_setting(
        "chanbig",
        "server",
        "channel_capacity",
        serde_json::json!(u64::MAX),
    );
    let r = zn(&dir, &["start"], &[], true);
    let _ = std::fs::remove_dir_all(&dir);
    assert_normal_error(r, &["server.channel_capacity"]);
}

#[test]
fn memory_limit_overflow_is_a_normal_error() {
    let dir = with_setting(
        "memovf",
        "engine",
        "memory_limit_mb",
        serde_json::json!(u64::MAX),
    );
    let r = zn(&dir, &["start"], &[], true);
    let _ = std::fs::remove_dir_all(&dir);
    assert_normal_error(r, &["engine.memory_limit_mb", "too large"]);
}

#[test]
fn memory_limit_overflow_also_stops_analyze() {
    let dir = with_setting(
        "memovf-an",
        "engine",
        "memory_limit_mb",
        serde_json::json!(u64::MAX),
    );
    let r = zn(&dir, &["analyze", "hello"], &[], true);
    let _ = std::fs::remove_dir_all(&dir);
    assert_normal_error(r, &["engine.memory_limit_mb"]);
}

#[test]
fn a_neural_model_that_cannot_load_is_a_normal_error() {
    let dir = workdir("neural-load");
    assert_eq!(zn(&dir, &["init"], &[], true).0, Some(0), "zn init failed");
    let model = dir.join("empty-model");
    std::fs::create_dir_all(&model).unwrap();
    // Nothing listens on port 9, so the download of the model fails at once.
    let r = zn(
        &dir,
        &["start"],
        &[
            ("ZN_NEURAL_MODEL_PATH", model.to_str().unwrap()),
            ("HF_ENDPOINT", "http://127.0.0.1:9"),
        ],
        false,
    );
    let _ = std::fs::remove_dir_all(&dir);
    assert_normal_error(
        r,
        &["neural model could not be loaded", "ZN_NEURAL_MODEL_PATH"],
    );
}

#[test]
fn a_mistyped_on_off_variable_is_a_normal_error() {
    for (var, value) in [
        ("ZN_NEURAL_ENABLED", "fasle"),
        ("ZN_KMS_ALLOW_CONFIG_FALLBACK", "tru"),
        ("ZN_NEAREST_NEIGHBOR_AUDIT", "nope"),
        ("ZN_FAST_BOOT", "maybe"),
    ] {
        let dir = workdir("badbool");
        let r = zn(&dir, &["start"], &[(var, value)], true);
        let _ = std::fs::remove_dir_all(&dir);
        assert_normal_error(r, &[var]);
    }
}
