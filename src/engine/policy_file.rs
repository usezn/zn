//! Atomic writing of policy files.

use anyhow::{anyhow, Result};
use std::path::Path;

/// Writes a policy file without following symlinks and without exposing a
/// half-written file. A symlink at `path` (even a dangling one) is refused.
/// The bytes go to a new temporary file in the same directory, created
/// exclusively so that nothing already there is followed, and that file is
/// then renamed over `path`; a rename replaces a symlink instead of writing
/// through it. The temporary name does not end in `.wasm`, so the policy
/// watcher ignores it until the rename.
pub fn write_policy_file(path: &Path, data: &[u8]) -> Result<()> {
    use std::io::Write;

    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            return Err(anyhow!("Policy file {:?} is a symlink", path));
        }
    }
    let dir = path
        .parent()
        .ok_or_else(|| anyhow!("Policy file {:?} has no directory", path))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow!("Policy file {:?} has no name", path))?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!(
        ".{}.{}.{}.tmp",
        file_name.to_string_lossy(),
        std::process::id(),
        nonce
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| anyhow!("Failed to create a temporary policy file: {}", e))?;
    if let Err(e) = file.write_all(data).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&tmp);
        return Err(anyhow!("Failed to write policy file: {}", e));
    }
    drop(file);
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(anyhow!("Failed to save policy file: {}", e));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Temporary files left in `dir` by a write (their names end in `.tmp`).
    fn leftovers(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .map(|r| {
                r.filter_map(|e| e.ok())
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|n| n.ends_with(".tmp"))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn writes_and_replaces_a_policy_file_without_leaving_a_temporary_file() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("policy.wasm");
        write_policy_file(&p, b"first").unwrap();
        write_policy_file(&p, b"second").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"second");
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn a_path_without_a_directory_or_a_name_is_refused() {
        let err = write_policy_file(Path::new("/"), b"x")
            .unwrap_err()
            .to_string();
        assert!(err.contains("has no directory"), "{err}");
        let dir = TempDir::new().unwrap();
        let err = write_policy_file(&dir.path().join(".."), b"x")
            .unwrap_err()
            .to_string();
        assert!(err.contains("has no name"), "{err}");
    }

    #[test]
    fn a_missing_directory_fails_without_creating_anything() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("missing").join("policy.wasm");
        let err = write_policy_file(&p, b"x").unwrap_err().to_string();
        assert!(err.contains("temporary policy file"), "{err}");
        assert!(!dir.path().join("missing").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_refused_and_its_target_is_not_written() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("target.txt");
        std::fs::write(&target, b"keep").unwrap();
        let link = dir.path().join("policy.wasm");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let err = write_policy_file(&link, b"x").unwrap_err().to_string();
        assert!(err.contains("is a symlink"), "{err}");
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");
        // A dangling link is refused too, and nothing is created where it points.
        std::fs::remove_file(&target).unwrap();
        assert!(write_policy_file(&link, b"x").is_err());
        assert!(!target.exists());
        assert!(leftovers(dir.path()).is_empty());
    }
}
