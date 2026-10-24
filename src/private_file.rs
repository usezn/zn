//! Private files: create and read files that only the current user may use.
//!
//! `write_private_file`, `replace_private_file` and `read_private_file` are the
//! one place that decides how a secret file (`data/ref.key`, `zn.json`, the
//! locally saved synced config) is created and trusted. On Unix the
//! file is created with mode 0600 and read back only when it is a regular file
//! (not a link) owned by the current user with no group or other access, in a
//! directory owned by the current user that others cannot write to. On other
//! platforms `restrict_to_owner` is the hook where an owner-only ACL is applied
//! to a newly created file; it does nothing there yet.

use std::io::{Error, ErrorKind, Result, Write};
use std::path::{Path, PathBuf};

/// Hook for platforms without Unix modes: restrict `path` to its owner (for
/// example with an owner-only ACL) right after it is created and before any
/// secret is written to it. Does nothing on Unix, where the mode is set when
/// the file is created.
#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path) -> Result<()> {
    Ok(())
}

/// Write `bytes` to a new private temporary file next to `path` (mode 0600 on
/// Unix, `create_new`, so it never follows a link), flushed to disk. Returns
/// the temporary path; the caller moves it into place or removes it.
fn write_private_temp(path: &Path, bytes: &[u8]) -> Result<PathBuf> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "no file name"))?
        .to_string_lossy()
        .into_owned();
    let tmp = dir.join(format!("{name}.tmp-{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let written = (|| {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        #[cfg(not(unix))]
        restrict_to_owner(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    match written {
        Ok(()) => Ok(tmp),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Write `bytes` to a new private file at `path`. The file is written to a
/// temporary private file in the same directory, flushed, and linked into
/// place, so a concurrent reader never sees a partial file. It never replaces
/// an existing file: when `path` exists the error kind is `AlreadyExists`.
pub fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = write_private_temp(path, bytes)?;
    let linked = std::fs::hard_link(&tmp, path);
    let _ = std::fs::remove_file(&tmp);
    linked
}

/// Write `bytes` to the private file at `path`, replacing it atomically when
/// it exists: a temporary private file in the same directory is renamed over
/// `path`, so a reader never sees a partial file and the result is owner-only.
/// A `path` that is a symbolic link or not a regular file (a directory, a
/// FIFO, a device) is refused with `PermissionDenied` and left untouched.
pub fn replace_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() || !meta.file_type().is_file() {
            return Err(Error::new(
                ErrorKind::PermissionDenied,
                format!(
                    "refusing to write {}: it must be a regular file, not a link",
                    path.display()
                ),
            ));
        }
    }
    let tmp = write_private_temp(path, bytes)?;
    let renamed = std::fs::rename(&tmp, path);
    if renamed.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    renamed
}

/// The user id of this process, found from a file it creates and removes.
#[cfg(unix)]
fn current_uid(dir: &Path) -> Result<u32> {
    use std::os::unix::fs::MetadataExt;
    let probe = dir.join(format!(".uid-probe-{}", std::process::id()));
    let _ = std::fs::remove_file(&probe);
    let f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)?;
    let uid = f.metadata()?.uid();
    drop(f);
    let _ = std::fs::remove_file(&probe);
    Ok(uid)
}

/// Read a private file. Refuses a link or anything that is not a regular
/// file; on Unix it also refuses a file or directory that another user owns,
/// a file with any group or other permission, and a directory that group or
/// others can write to. `NotFound` is returned as is when the file is absent.
pub fn read_private_file(path: &Path) -> Result<Vec<u8>> {
    let lmeta = std::fs::symlink_metadata(path)?;
    let refuse = |why: &str| {
        Error::new(
            ErrorKind::PermissionDenied,
            format!("{} {}", path.display(), why),
        )
    };
    if lmeta.file_type().is_symlink() || !lmeta.is_file() {
        return Err(refuse("must be a regular file, not a link"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let dir = path.parent().unwrap_or_else(|| Path::new("."));
        let dir = if dir.as_os_str().is_empty() {
            Path::new(".")
        } else {
            dir
        };
        let me = current_uid(dir)?;
        if lmeta.uid() != me {
            return Err(refuse("is owned by another user"));
        }
        if lmeta.permissions().mode() & 0o077 != 0 {
            return Err(refuse(
                "must not be accessible by group or others (chmod 600)",
            ));
        }
        let dmeta = std::fs::metadata(dir)?;
        if dmeta.uid() != me {
            return Err(refuse("lives in a directory owned by another user"));
        }
        if dmeta.permissions().mode() & 0o022 != 0 {
            return Err(refuse(
                "lives in a directory that group or others can write to",
            ));
        }
        let mut f = std::fs::File::open(path)?;
        let ometa = f.metadata()?;
        if ometa.ino() != lmeta.ino() || ometa.dev() != lmeta.dev() {
            return Err(refuse("changed while it was being opened"));
        }
        let mut out = Vec::new();
        std::io::Read::read_to_end(&mut f, &mut out)?;
        Ok(out)
    }
    #[cfg(not(unix))]
    {
        std::fs::read(path)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn write_then_read_round_trips_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("k");
        write_private_file(&p, b"one").unwrap();
        assert_eq!(read_private_file(&p).unwrap(), b"one");
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let e = write_private_file(&p, b"two").unwrap_err();
        assert_eq!(e.kind(), ErrorKind::AlreadyExists);
        assert_eq!(read_private_file(&p).unwrap(), b"one");
        assert_eq!(
            read_private_file(&dir.path().join("none"))
                .unwrap_err()
                .kind(),
            ErrorKind::NotFound
        );
    }

    #[test]
    fn replace_overwrites_atomically_and_refuses_links_and_non_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("zn.json");
        std::fs::write(&p, b"old").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        replace_private_file(&p, b"new").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"new");
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        let target = dir.path().join("target");
        std::fs::write(&target, b"keep").unwrap();
        let link = dir.path().join("link.json");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let e = replace_private_file(&link, b"x").unwrap_err();
        assert_eq!(e.kind(), ErrorKind::PermissionDenied);
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");

        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        let e = replace_private_file(&sub, b"x").unwrap_err();
        assert_eq!(e.kind(), ErrorKind::PermissionDenied);
        assert!(sub.is_dir());
    }

    #[test]
    fn links_open_files_and_open_directories_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::write(&real, [7u8; 32]).unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(read_private_file(&link).is_err(), "a link must be refused");
        assert!(read_private_file(&real).is_ok());

        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert!(read_private_file(&real).is_err(), "group read must be refused");
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o600)).unwrap();

        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(
            read_private_file(&real).is_err(),
            "a world-writable directory must be refused"
        );
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(read_private_file(&real).is_ok());
    }
}
