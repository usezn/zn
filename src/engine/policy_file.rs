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

    #[test]
    fn writing_into_a_missing_directory_fails_and_leaves_nothing_behind() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("missing").join("p.wasm");
        let err = write_policy_file(&path, b"x").expect_err("must fail");
        assert!(err.to_string().contains("temporary policy file"), "{err}");
        assert_eq!(std::fs::read_dir(dir.path()).expect("list").count(), 0);
    }

    #[test]
    fn a_path_without_a_directory_part_is_refused() {
        let err = write_policy_file(Path::new(""), b"x").expect_err("must fail");
        assert!(err.to_string().contains("has no directory"), "{err}");
    }

    #[test]
    fn a_path_without_a_file_name_is_refused() {
        let err =
            write_policy_file(Path::new("zn-nonexistent-dir/.."), b"x").expect_err("must fail");
        assert!(err.to_string().contains("has no name"), "{err}");
    }

    #[test]
    fn a_directory_in_the_way_fails_the_save_and_removes_the_temporary_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("p.wasm");
        std::fs::create_dir(&path).expect("directory in the way");
        let err = write_policy_file(&path, b"x").expect_err("must fail");
        assert!(
            err.to_string().contains("Failed to save policy file"),
            "{err}"
        );
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .expect("list")
            .map(|e| e.expect("entry").file_name())
            .collect();
        assert_eq!(
            leftovers.len(),
            1,
            "only the directory remains: {leftovers:?}"
        );
        assert!(path.is_dir());
    }
}
