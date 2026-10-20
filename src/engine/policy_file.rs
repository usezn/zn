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
