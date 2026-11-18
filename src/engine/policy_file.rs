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
    use super::write_policy_file;

    fn names(dir: &std::path::Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn a_missing_directory_is_an_error_and_creates_nothing() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("absent").join("p.wasm");
        let err = write_policy_file(&path, b"x").unwrap_err().to_string();
        assert!(
            err.starts_with("Failed to create a temporary policy file"),
            "{err}"
        );
        assert!(!root.path().join("absent").exists());
        assert!(names(root.path()).is_empty());
    }

    #[test]
    fn empty_data_writes_an_empty_file_and_replaces_older_content() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("p.wasm");
        write_policy_file(&path, b"old").unwrap();
        write_policy_file(&path, b"").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), Vec::<u8>::new());
        assert_eq!(names(root.path()), vec!["p.wasm".to_string()]);
    }

    #[test]
    fn binary_data_is_written_byte_for_byte() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("p.wasm");
        let data = [0u8, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0xff, 0xfe];
        write_policy_file(&path, &data).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), data);
    }

    #[test]
    fn a_target_that_cannot_be_replaced_fails_and_leaves_no_temporary() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("p.wasm");
        std::fs::create_dir(&path).unwrap();
        let err = write_policy_file(&path, b"x").unwrap_err().to_string();
        assert!(err.starts_with("Failed to save policy file"), "{err}");
        assert!(path.is_dir());
        assert_eq!(names(root.path()), vec!["p.wasm".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_refused_with_its_own_message_and_its_target_is_untouched() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target.wasm");
        std::fs::write(&target, b"keep").unwrap();
        let link = root.path().join("link.wasm");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let err = write_policy_file(&link, b"x").unwrap_err().to_string();
        assert!(err.contains("is a symlink"), "{err}");
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn a_path_without_a_directory_is_refused() {
        let err = write_policy_file(std::path::Path::new("/"), b"x")
            .unwrap_err()
            .to_string();
        assert!(err.contains("has no directory"), "{err}");
    }
}
