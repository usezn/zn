//! `zn init` must not copy secrets from the environment into zn.json, and
//! must create the file readable by its owner only (Unix).

use std::path::PathBuf;
use std::process::{Command, Stdio};

fn workdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("zn-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const FAKE: [(&str, &str); 7] = [
    ("ZN_MCP_WS_TOKEN", "fake-ws-token-0000-not-real"),
    ("ZN_API_KEY", "fake-api-key-0000-not-real"),
    ("ZN_DB_KEY", "fake-db-key-0000-not-real"),
    ("ZN_JWT_SECRET", "fake-jwt-secret-0000-not-real-pad"),
    ("ZN_NAMESPACE", "fake-namespace-0000-example"),
    ("ZN_KMS_KEY_ID", "fake-kms-key-id-0000-example"),
    ("ZN_KMS_REGION", "fake-region-0000-example"),
];

fn run_init(dir: &PathBuf) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_zn"));
    cmd.arg("init")
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (k, v) in FAKE {
        cmd.env(k, v);
    }
    let status = cmd.status().expect("run zn init");
    assert!(status.success(), "zn init failed: {status:?}");
}

#[test]
fn init_writes_no_environment_secrets() {
    let dir = workdir("init-no-env-secrets");
    run_init(&dir);
    let text = std::fs::read_to_string(dir.join("zn.json")).expect("zn.json written");
    for (name, value) in FAKE {
        assert!(!text.contains(value), "{name} value leaked into zn.json");
    }
    let config: zn::config::ZnConfig =
        serde_json::from_str(&text).expect("zn.json loads as a ZnConfig");
    config.validate().expect("zn.json passes validate()");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn init_creates_zn_json_owner_only_and_tightens_an_existing_file() {
    use std::os::unix::fs::PermissionsExt;
    let dir = workdir("init-mode");
    run_init(&dir);
    let mode = |p: &PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    let file = dir.join("zn.json");
    assert_eq!(mode(&file), 0o600);

    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
    run_init(&dir);
    assert_eq!(mode(&file), 0o600);
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn init_refuses_a_symlinked_zn_json() {
    let dir = workdir("init-symlink");
    let real = dir.join("real.json");
    std::fs::write(&real, "{}").unwrap();
    std::os::unix::fs::symlink(&real, dir.join("zn.json")).unwrap();
    let status = Command::new(env!("CARGO_BIN_EXE_zn"))
        .arg("init")
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("run zn init");
    assert!(!status.success());
    assert_eq!(std::fs::read_to_string(&real).unwrap(), "{}");
    let _ = std::fs::remove_dir_all(&dir);
}
