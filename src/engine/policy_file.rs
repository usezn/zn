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

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn a_missing_directory_is_an_error_and_nothing_is_created() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("absent");
        let err = write_policy_file(&missing.join("p.wasm"), b"x").unwrap_err();
        assert!(err.to_string().contains("temporary policy file"), "{err}");
        assert!(!missing.exists());
        assert!(names(dir.path()).is_empty());
    }

    #[test]
    fn a_path_without_a_name_or_directory_is_refused() {
        assert!(write_policy_file(Path::new("/"), b"x").is_err());
        assert!(write_policy_file(Path::new(""), b"x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_directory_keeps_the_old_file_and_leaves_no_temporary() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.wasm");
        std::fs::write(&path, b"old").unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        // root ignores directory permissions: the case cannot be built there.
        let probe = dir.path().join("probe");
        let can_write_anyway = std::fs::write(&probe, b"").is_ok();
        let result = write_policy_file(&path, b"new");
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        if can_write_anyway {
            return;
        }
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        assert_eq!(names(dir.path()), ["p.wasm"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_a_real_file_is_refused_and_the_target_is_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("real.wasm");
        std::fs::write(&target, b"real").unwrap();
        let link = dir.path().join("link.wasm");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let err = write_policy_file(&link, b"evil").unwrap_err();
        assert!(err.to_string().contains("is a symlink"), "{err}");
        assert_eq!(std::fs::read(&target).unwrap(), b"real");
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(names(dir.path()), ["link.wasm", "real.wasm"]);
    }

    #[test]
    fn a_failed_rename_leaves_the_destination_and_no_temporary() {
        // A directory at the destination makes the final rename fail after the bytes were written.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.wasm");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("keep"), b"k").unwrap();
        let err = write_policy_file(&path, b"data").unwrap_err();
        assert!(err.to_string().contains("save policy file"), "{err}");
        assert!(path.is_dir());
        assert_eq!(std::fs::read(path.join("keep")).unwrap(), b"k");
        assert_eq!(names(dir.path()), ["p.wasm"]);
    }

    #[test]
    fn an_existing_file_is_replaced_whole_and_never_appended_to() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.wasm");
        std::fs::write(&path, vec![7u8; 4096]).unwrap();
        write_policy_file(&path, b"short").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"short");
        write_policy_file(&path, b"").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"");
        assert_eq!(names(dir.path()), ["p.wasm"]);
    }

    #[test]
    fn a_reader_never_sees_a_partial_file_while_writers_replace_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.wasm");
        let a = vec![b'a'; 64 * 1024];
        let b = vec![b'b'; 64 * 1024];
        write_policy_file(&path, &a).unwrap();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader = {
            let (path, stop, a, b) = (path.clone(), stop.clone(), a.clone(), b.clone());
            std::thread::spawn(move || {
                let mut seen = 0;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let got = std::fs::read(&path).unwrap();
                    assert!(got == a || got == b, "partial file of {} bytes", got.len());
                    seen += 1;
                }
                seen
            })
        };
        for i in 0..200 {
            write_policy_file(&path, if i % 2 == 0 { &b } else { &a }).unwrap();
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(reader.join().unwrap() > 0);
        assert_eq!(names(dir.path()), ["p.wasm"]);
    }
}
