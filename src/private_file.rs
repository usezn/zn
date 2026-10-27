//! Writing and reading files that only their owner can access.
//!
//! `zn init` writes `zn.json` and the audit code writes `ref.key`. Both can hold
//! material that other local accounts must not read, so they are created through
//! this module instead of `std::fs::write`, and the key is read back through
//! [`read_private_file`] instead of `std::fs::read`.
//!
//! What [`create_private_file`] does, on every platform:
//!
//! 1. Refuses a target that is a symbolic link or anything but a regular file.
//!    The link is never followed and its destination is never touched.
//! 2. Writes the bytes to a new temporary file in the same folder. The temporary
//!    file is created exclusively (it must not exist yet) and with the owner-only
//!    protection already in place, so there is no moment when it is readable by
//!    others.
//! 3. Checks the protection of the temporary file before it goes live.
//! 4. Moves it onto the target in one step and checks the target again.
//!
//! Any failure removes the temporary file and returns an error: the function
//! fails closed and never leaves a half-written or world-readable file at the
//! target path.
//!
//! Protection by platform:
//!
//! - Unix: mode `0600`, opened with `O_EXCL` and `O_NOFOLLOW`, whatever the
//!   umask. The check accepts a file owned by the effective user that has no
//!   access for group or others and no setuid, setgid or sticky bit (so `0400`
//!   and `0700` pass, `0640` and `04600` do not).
//! - Windows: the file is created with a security descriptor that makes the
//!   current user the owner and grants full control to that user only, with a
//!   protected DACL (no inherited entries). The descriptor is passed to
//!   `CreateFileW`, so it applies from the first moment. The check reads it back
//!   and accepts nothing else.
//!
//! Why SYSTEM and Administrators get no entry on Windows: an administrator (or
//! SYSTEM) can always take ownership of a file or read it with the backup
//! privilege, so leaving them out gives no secrecy against them. What it does
//! give is that no inherited or group entry can widen the access, and that the
//! check stays simple (one entry, the owner). The consequences are deliberate:
//! tools that run as SYSTEM without backup semantics (some indexers, backup or
//! sync agents) cannot read these files, and if zn runs as a LocalSystem
//! service the file belongs to SYSTEM and the interactive user cannot read it.
//!
//! # Reading
//!
//! Checking a file by path and then reading it by path leaves a gap in which the
//! file can be swapped for a link. [`open_private`] and [`read_private_file`]
//! close it: the file is opened without following a link in its last component
//! (`O_NOFOLLOW` on Unix, `FILE_FLAG_OPEN_REPARSE_POINT` on Windows) and the
//! checks (regular file, not a reparse point, owner, mode or DACL) run on the
//! handle that was opened, which is the one the bytes are read from. Callers that
//! read a private file must do it only through these two functions. Links in the
//! folders above the file are still followed, as with any path.
//!
//! # File systems without Unix permissions
//!
//! Some file systems cannot store Unix permissions: a Windows drive mounted in
//! WSL (`/mnt/c` without the `metadata` option, the default), FAT and exFAT, and
//! some network shares. There `chmod` either fails or does nothing and every file
//! looks like `0777`. The policy is to fail closed and not to weaken the check:
//! creating a private file returns [`io::ErrorKind::Unsupported`] with a message
//! that says what to do (use a folder on a Linux file system, or mount the drive
//! with permission support), and [`verify_private`] and [`open_private`] report
//! the wrong mode with the same hint.
//!
//! Some file systems cannot make hard links (certain FUSE and network mounts).
//! [`create_private_file_new`] normally publishes the file with a hard link
//! because that fails atomically when the target exists. When the link is not
//! supported it creates the target itself with `O_EXCL`, which is just as
//! race-safe about "who creates it". The difference is that the content is
//! written into the final name, so a reader can briefly see an empty or partial
//! file, and a crash mid-write leaves a truncated file. Readers of such a file
//! must treat a wrong length as an error and retry.
//!
//! An existing target is handled explicitly:
//!
//! - [`create_private_file`] replaces an existing regular file. The old file is
//!   not opened, truncated or re-protected: its directory entry is replaced by
//!   the new file, so other hard links to the old file keep the old content and
//!   permissions.
//! - [`create_private_file_new`] never replaces: it fails with
//!   [`io::ErrorKind::AlreadyExists`] when the target exists, and when several
//!   processes race, exactly one of them creates it.
//!
//! The target's folder is not changed. Callers that need a private folder must
//! create and check it themselves.
//!
//! # Leftover temporary files
//!
//! A process that dies between creating the temporary file and moving it leaves
//! a `.zn-private-*.tmp` file (owner-only, with the content) in the folder. Every
//! write removes such files when they are more than an hour old
//! ([`remove_stale_temp_files`] does the same on demand), and
//! [`TEMP_FILE_PATTERN`] is the pattern for a `.gitignore` so that `git add .`
//! never picks one up.

use std::fs::{self, File, Metadata};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Pattern (for a `.gitignore`) that matches the temporary files of this module.
pub const TEMP_FILE_PATTERN: &str = ".zn-private-*.tmp";

const TEMP_PREFIX: &str = ".zn-private-";
const TEMP_SUFFIX: &str = ".tmp";
/// Temporary files older than this belong to a process that is gone.
const STALE_AFTER: Duration = Duration::from_secs(3600);

/// Write `bytes` to `path` as a private file, replacing a regular file that is
/// already there. See the module documentation for the exact behaviour.
pub fn create_private_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_private(path, bytes, true)
}

/// Like [`create_private_file`], but fails with [`io::ErrorKind::AlreadyExists`]
/// instead of replacing an existing target. The existing file is left as it is.
pub fn create_private_file_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_private(path, bytes, false)
}

/// Open `path` for reading if, and only if, it is a private regular file: not a
/// link, owned by the current user and without access for anybody else (see the
/// module documentation). The checks run on the opened handle, so the file read
/// is the file checked. Fails with [`io::ErrorKind::PermissionDenied`] when the
/// protection is wrong and [`io::ErrorKind::InvalidInput`] for a link or a file
/// that is not regular.
pub fn open_private(path: &Path) -> io::Result<File> {
    sys::open_private(path)
}

/// Read a whole private file, with the checks of [`open_private`].
pub fn read_private_file(path: &Path) -> io::Result<Vec<u8>> {
    let mut file = open_private(path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Check that `path` is a regular file (not a link) that only its owner can
/// access: owned by the effective user with no group, other or special mode bits
/// on Unix; owned by the current user with a protected DACL that has no entry for
/// anybody else on Windows. Returns [`io::ErrorKind::PermissionDenied`] when it
/// is not. This is [`open_private`] without keeping the handle.
pub fn verify_private(path: &Path) -> io::Result<()> {
    open_private(path).map(|_| ())
}

/// Remove `.zn-private-*.tmp` files in `dir` that are more than an hour old
/// (left behind by a process that died while writing). Only regular files with
/// the exact name shape of this module are touched. Returns how many were
/// removed. Failures on single files are ignored.
pub fn remove_stale_temp_files(dir: &Path) -> io::Result<usize> {
    remove_temp_files_older_than(dir, STALE_AFTER)
}

fn remove_temp_files_older_than(dir: &Path, age: Duration) -> io::Result<usize> {
    let mut removed = 0;
    for entry in fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !is_temp_name(name) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let old = meta
            .modified()
            .ok()
            .and_then(|m| SystemTime::now().duration_since(m).ok())
            .is_some_and(|d| d >= age);
        if old && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

/// `.zn-private-<pid>-<counter>-<8 hex digits>.tmp`
fn is_temp_name(name: &str) -> bool {
    let Some(rest) = name
        .strip_prefix(TEMP_PREFIX)
        .and_then(|r| r.strip_suffix(TEMP_SUFFIX))
    else {
        return false;
    };
    let parts: Vec<&str> = rest.split('-').collect();
    parts.len() == 3
        && parts[..2]
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && parts[2].len() == 8
        && parts[2].bytes().all(|b| b.is_ascii_hexdigit())
}

fn denied(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, msg)
}

fn not_regular(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("not a regular file: {}", path.display()),
    )
}

fn link_refused(path: &Path, what: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("refusing to {what} through a link: {}", path.display()),
    )
}

fn require_regular(meta: &Metadata, path: &Path) -> io::Result<()> {
    if meta.file_type().is_symlink() {
        return Err(link_refused(path, "write"));
    }
    if !meta.is_file() {
        return Err(not_regular(path));
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8], replace: bool) -> io::Result<()> {
    if path.file_name().is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path has no file name: {}", path.display()),
        ));
    }
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            require_regular(&meta, path)?;
            if !replace {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("already exists: {}", path.display()),
                ));
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let dir: PathBuf = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    // Best effort: clear temporary files that a crashed writer left behind.
    let _ = remove_stale_temp_files(&dir);

    let (tmp, mut file) = create_temp(&dir)?;
    let staged = (|| -> io::Result<()> {
        file.write_all(bytes)?;
        file.sync_all()?;
        // The protection travels with the file when it is moved, so checking
        // the temporary file now means a bad one never reaches the target.
        sys::verify_file(&file)
    })();
    // Close before moving: Windows will not move an open file.
    drop(file);
    if let Err(e) = staged {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    let mut installed = sys::install(&tmp, path, replace);
    if !replace && matches!(&installed, Err(e) if sys::hard_link_unsupported(e)) {
        // This file system cannot make hard links. Fall back to creating the
        // target itself with O_EXCL (see the module documentation): still atomic
        // about who creates it, and the file is private from its first byte.
        installed = create_in_place(path, bytes);
    }
    // With a rename the temporary name is already gone (NotFound, ignored); with
    // a hard link it is the second name of the new file and must be removed.
    let _ = fs::remove_file(&tmp);
    installed?;
    if let Err(e) = verify_private(path) {
        // Something changed the file between the check and now: do not leave
        // secret content behind that is not provably private.
        let _ = fs::remove_file(path);
        return Err(e);
    }
    sys::sync_dir(&dir);
    Ok(())
}

/// Create `path` exclusively and write `bytes` into it. Used when the target
/// cannot be published with a hard link; removes the file again on a failed write.
fn create_in_place(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = sys::create_new_private(path)?;
    let written = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(e) = written {
        let _ = fs::remove_file(path);
        return Err(e);
    }
    Ok(())
}

fn create_temp(dir: &Path) -> io::Result<(PathBuf, File)> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    for _ in 0..16 {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let tmp = dir.join(format!(
            "{TEMP_PREFIX}{}-{}-{:08x}{TEMP_SUFFIX}",
            std::process::id(),
            n,
            nanos
        ));
        match sys::create_new_private(&tmp) {
            Ok(f) => return Ok((tmp, f)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not find a free temporary file name",
    ))
}

#[cfg(unix)]
mod sys {
    use super::{denied, link_refused, not_regular};
    use std::fs::{self, File, OpenOptions, Permissions};
    use std::io;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::Path;

    const NO_PERMISSIONS: &str = "this file system does not keep Unix permissions (for example a \
        Windows drive mounted in WSL, FAT or exFAT, or some network shares), so an owner-only file \
        cannot be created here; use a folder on a Linux file system, or mount the drive with \
        permission support (for WSL, the metadata mount option)";

    fn no_permissions() -> io::Error {
        io::Error::new(io::ErrorKind::Unsupported, NO_PERMISSIONS)
    }

    pub fn create_new_private(path: &Path) -> io::Result<File> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)?;
        match settle_mode(&file) {
            Ok(()) => Ok(file),
            Err(e) => {
                // Do not leave a file with unknown protection behind.
                drop(file);
                let _ = fs::remove_file(path);
                Err(e)
            }
        }
    }

    /// Make the mode exactly 0600 and prove it stuck. The umask can only remove
    /// bits, but a file system without permissions ignores or refuses chmod and
    /// shows a fixed mode: that is reported as such, not as a bad mode.
    fn settle_mode(file: &File) -> io::Result<()> {
        if let Err(e) = file.set_permissions(Permissions::from_mode(0o600)) {
            return Err(match e.raw_os_error() {
                Some(libc::EPERM) | Some(libc::ENOTSUP) | Some(libc::ENOSYS) => no_permissions(),
                _ => e,
            });
        }
        if file.metadata()?.mode() & 0o7777 != 0o600 {
            return Err(no_permissions());
        }
        Ok(())
    }

    pub fn open_private(path: &Path) -> io::Result<File> {
        // O_NOFOLLOW: a link in the last component fails with ELOOP instead of
        // being followed. O_NONBLOCK: opening a FIFO must not hang; it is a
        // no-op for the regular file we insist on below.
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|e| match e.raw_os_error() {
                Some(libc::ELOOP) => link_refused(path, "read"),
                _ => e,
            })?;
        let meta = file.metadata()?; // fstat on the opened descriptor
        if !meta.is_file() {
            return Err(not_regular(path));
        }
        check(&meta)?;
        Ok(file)
    }

    pub fn verify_file(file: &File) -> io::Result<()> {
        check(&file.metadata()?)
    }

    fn check(meta: &fs::Metadata) -> io::Result<()> {
        let mode = meta.mode() & 0o7777;
        if mode & 0o7077 != 0 {
            return Err(denied(format!(
                "file mode is {mode:04o}, expected no access for group or others and no \
                 setuid, setgid or sticky bit (run chmod 600 on it; if the mode does not change, \
                 the file system does not keep Unix permissions: a Windows drive mounted in WSL, \
                 FAT or exFAT, some network shares)"
            )));
        }
        // SAFETY: geteuid has no preconditions and cannot fail.
        let euid = unsafe { libc::geteuid() };
        if meta.uid() != euid {
            return Err(denied(format!(
                "file is owned by uid {}, not by the current user (uid {})",
                meta.uid(),
                euid
            )));
        }
        Ok(())
    }

    pub fn install(tmp: &Path, path: &Path, replace: bool) -> io::Result<()> {
        if replace {
            fs::rename(tmp, path)
        } else {
            // Fails with AlreadyExists if the target appeared in the meantime.
            fs::hard_link(tmp, path)
        }
    }

    /// True when `link(2)` failed because the file system cannot make hard links.
    pub fn hard_link_unsupported(e: &io::Error) -> bool {
        matches!(
            e.raw_os_error(),
            Some(libc::EPERM) | Some(libc::ENOTSUP) | Some(libc::ENOSYS)
        )
    }

    pub fn sync_dir(dir: &Path) {
        if let Ok(d) = File::open(dir) {
            let _ = d.sync_all();
        }
    }
}

#[cfg(windows)]
mod sys {
    use super::{denied, link_refused, not_regular};
    use std::ffi::{c_void, OsStr};
    use std::fs::{self, File};
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
    use std::path::Path;
    use std::ptr::{addr_of, null_mut};
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{
        CloseHandle, LocalFree, ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, HANDLE, HLOCAL,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        AclSizeInformation, CopySid, EqualSid, GetAce, GetAclInformation, GetLengthSid,
        GetSecurityDescriptorControl, GetTokenInformation, IsValidSid, TokenUser,
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, MoveFileExW, CREATE_NEW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ,
        FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // Values fixed by the Win32 ABI (winnt.h).
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const INHERITED_ACE: u8 = 0x10;
    const SE_DACL_PRESENT: u16 = 0x0004;
    const SE_DACL_PROTECTED: u16 = 0x1000;

    /// Pauses between the attempts to move a file that something else has open
    /// for an instant (antivirus, search indexer, backup agent): 630 ms in all.
    const BUSY_RETRY_PAUSES_MS: [u64; 6] = [10, 20, 40, 80, 160, 320];

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Sharing violation or access denied: what a filter driver that has the file
    /// open for a moment produces. Anything else is returned at once.
    fn is_busy(e: &io::Error) -> bool {
        matches!(
            e.raw_os_error().map(|c| c as u32),
            Some(ERROR_SHARING_VIOLATION) | Some(ERROR_ACCESS_DENIED)
        )
    }

    /// Run `op`, and run it again after each pause in `pauses_ms` while it fails
    /// with a busy error. Like the Node `renameWithRetry`.
    pub fn retry_busy<T>(
        pauses_ms: &[u64],
        mut op: impl FnMut() -> io::Result<T>,
    ) -> io::Result<T> {
        let mut pauses = pauses_ms.iter();
        loop {
            match op() {
                Err(e) if is_busy(&e) => match pauses.next() {
                    Some(ms) => std::thread::sleep(Duration::from_millis(*ms)),
                    None => return Err(e),
                },
                other => return other,
            }
        }
    }

    /// The SID of the user this process runs as, copied out of the token.
    struct UserSid {
        // u32 elements keep the copy aligned for the SID functions.
        buf: Vec<u32>,
    }

    impl UserSid {
        fn current() -> io::Result<Self> {
            // SAFETY: plain Win32 calls; every out-pointer is a live local and the
            // token handle is closed on all paths.
            unsafe {
                let mut token: HANDLE = null_mut();
                if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                    return Err(io::Error::last_os_error());
                }
                let result = Self::from_token(token);
                CloseHandle(token);
                result
            }
        }

        unsafe fn from_token(token: HANDLE) -> io::Result<Self> {
            let mut needed = 0u32;
            GetTokenInformation(token, TokenUser, null_mut(), 0, &mut needed);
            if needed == 0 {
                return Err(io::Error::last_os_error());
            }
            // u64 elements: TOKEN_USER holds a pointer, so keep 8-byte alignment.
            let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
            if GetTokenInformation(
                token,
                TokenUser,
                buf.as_mut_ptr() as *mut c_void,
                needed,
                &mut needed,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let sid = (*(buf.as_ptr() as *const TOKEN_USER)).User.Sid;
            if sid.is_null() || IsValidSid(sid) == 0 {
                return Err(denied("the process token has no valid user SID".into()));
            }
            let len = GetLengthSid(sid);
            let mut copy = vec![0u32; (len as usize).div_ceil(4)];
            if CopySid(len, copy.as_mut_ptr() as PSID, sid) == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(UserSid { buf: copy })
        }

        fn psid(&self) -> PSID {
            self.buf.as_ptr() as PSID
        }

        fn to_sddl_string(&self) -> io::Result<String> {
            // SAFETY: ConvertSidToStringSidW allocates a NUL-terminated UTF-16
            // string that is read once and released with LocalFree.
            unsafe {
                let mut p: *mut u16 = null_mut();
                if ConvertSidToStringSidW(self.psid(), &mut p) == 0 {
                    return Err(io::Error::last_os_error());
                }
                let mut n = 0usize;
                while *p.add(n) != 0 {
                    n += 1;
                }
                let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, n));
                LocalFree(p as HLOCAL);
                Ok(s)
            }
        }
    }

    /// Create `path` (it must not exist) with the owner-only security descriptor
    /// applied at creation. The handle allows writing and reading the descriptor.
    pub fn create_new_private(path: &Path) -> io::Result<File> {
        let sid = UserSid::current()?.to_sddl_string()?;
        // Owner = the user, protected DACL (P), one allow entry (A) with full file
        // access (FA) for the user. Nothing for SYSTEM, Administrators or anyone
        // else, on purpose: see "Why SYSTEM and Administrators get no entry" in the
        // module documentation.
        let sddl: Vec<u16> = OsStr::new(&format!("O:{sid}D:P(A;;FA;;;{sid})"))
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let name = wide(path);
        // SAFETY: the descriptor returned by the conversion is only used for the
        // CreateFileW call and freed right after; the handle returned by CreateFileW
        // is owned by the File built from it.
        unsafe {
            let mut psd: PSECURITY_DESCRIPTOR = null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut psd,
                null_mut(),
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            let attrs = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: psd,
                bInheritHandle: 0,
            };
            let handle = CreateFileW(
                name.as_ptr(),
                FILE_GENERIC_WRITE,
                0, // no sharing while we write
                &attrs,
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                null_mut(),
            );
            let err = if handle == INVALID_HANDLE_VALUE {
                Some(io::Error::last_os_error())
            } else {
                None
            };
            LocalFree(psd as HLOCAL);
            match err {
                Some(e) => Err(e),
                None => Ok(File::from_raw_handle(handle as RawHandle)),
            }
        }
    }

    /// Open an existing file for reading without following a reparse point in the
    /// last component, then check it on the handle.
    pub fn open_private(path: &Path) -> io::Result<File> {
        let name = wide(path);
        // SAFETY: `name` is NUL-terminated and outlives the call; the handle
        // returned is owned by the File built from it.
        let file = unsafe {
            let handle = CreateFileW(
                name.as_ptr(),
                FILE_GENERIC_READ, // includes READ_CONTROL, needed for the DACL
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                // Open a symbolic link or junction itself, not its destination.
                // (No FILE_FLAG_BACKUP_SEMANTICS: a folder cannot be opened.)
                FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            );
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            File::from_raw_handle(handle as RawHandle)
        };
        let attrs = file.metadata()?.file_attributes(); // GetFileInformationByHandle
        if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(link_refused(path, "read"));
        }
        if attrs & FILE_ATTRIBUTE_DIRECTORY != 0 {
            return Err(not_regular(path));
        }
        verify_file(&file)?;
        Ok(file)
    }

    pub fn verify_file(file: &File) -> io::Result<()> {
        let handle = file.as_raw_handle() as HANDLE;
        let mut owner: PSID = null_mut();
        let mut dacl: *mut ACL = null_mut();
        let mut psd: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: out-pointers are live locals; psd is released below.
        let rc = unsafe {
            GetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut psd,
            )
        };
        if rc != 0 {
            return Err(io::Error::from_raw_os_error(rc as i32));
        }
        let result = check(owner, dacl, psd);
        // SAFETY: psd was allocated by GetSecurityInfo.
        unsafe { LocalFree(psd as HLOCAL) };
        result
    }

    /// Fail closed unless: the owner is the current user, the DACL is present and
    /// protected, and every entry is an explicit (not inherited) allow entry for
    /// the current user, with at least one entry.
    fn check(owner: PSID, dacl: *mut ACL, psd: PSECURITY_DESCRIPTOR) -> io::Result<()> {
        let me = UserSid::current()?;
        // SAFETY: owner, dacl and psd come from a successful GetSecurityInfo call
        // and stay valid until the caller frees psd; ACE pointers point inside
        // the DACL.
        unsafe {
            if owner.is_null() || EqualSid(owner, me.psid()) == 0 {
                return Err(denied("the file is not owned by the current user".into()));
            }
            let mut control: u16 = 0;
            let mut revision: u32 = 0;
            if GetSecurityDescriptorControl(psd, &mut control, &mut revision) == 0 {
                return Err(io::Error::last_os_error());
            }
            if control & SE_DACL_PRESENT == 0 || dacl.is_null() {
                return Err(denied("the file has no DACL (everybody has access)".into()));
            }
            if control & SE_DACL_PROTECTED == 0 {
                return Err(denied(
                    "the file DACL is not protected (it inherits entries from the folder)".into(),
                ));
            }
            let mut info: ACL_SIZE_INFORMATION = zeroed();
            if GetAclInformation(
                dacl,
                &mut info as *mut ACL_SIZE_INFORMATION as *mut c_void,
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
            if info.AceCount == 0 {
                return Err(denied("the file DACL is empty".into()));
            }
            for i in 0..info.AceCount {
                let mut ace: *mut c_void = null_mut();
                if GetAce(dacl, i, &mut ace) == 0 {
                    return Err(io::Error::last_os_error());
                }
                let header = &*(ace as *const ACE_HEADER);
                if header.AceType != ACCESS_ALLOWED_ACE_TYPE {
                    return Err(denied(format!(
                        "the file DACL has an unexpected entry type ({})",
                        header.AceType
                    )));
                }
                if header.AceFlags & INHERITED_ACE != 0 {
                    return Err(denied("the file DACL has an inherited entry".into()));
                }
                let sid = addr_of!((*(ace as *const ACCESS_ALLOWED_ACE)).SidStart) as PSID;
                if EqualSid(sid, me.psid()) == 0 {
                    return Err(denied(
                        "the file DACL has an entry for an account other than the owner".into(),
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn install(tmp: &Path, path: &Path, replace: bool) -> io::Result<()> {
        if replace {
            retry_busy(&BUSY_RETRY_PAUSES_MS, || fs::rename(tmp, path))
        } else {
            // No MOVEFILE_REPLACE_EXISTING: fails with AlreadyExists when the
            // target is there, atomically, on any file system.
            let from = wide(tmp);
            let to = wide(path);
            retry_busy(&BUSY_RETRY_PAUSES_MS, || {
                // SAFETY: both buffers are NUL-terminated and outlive the call.
                if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } == 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            })
        }
    }

    /// Windows publishes with MoveFileExW, which needs no hard links.
    pub fn hard_link_unsupported(_e: &io::Error) -> bool {
        false
    }

    // No directory sync: NTFS does not offer one, and the move is not made with
    // MOVEFILE_WRITE_THROUGH. A power cut right after the move can lose the new
    // name, never expose a half-written or unprotected file.
    pub fn sync_dir(_dir: &Path) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::sync::{Arc, Barrier};

    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(".zn-private-"))
            .collect()
    }

    #[test]
    fn creates_a_private_file_with_the_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("zn.json");
        create_private_file(&path, b"{\"a\":1}").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{\"a\":1}");
        verify_private(&path).unwrap();
        assert!(
            leftovers(dir.path()).is_empty(),
            "temporary file left behind"
        );
    }

    #[test]
    fn replaces_an_existing_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("zn.json");
        fs::write(&path, b"old and readable by others").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        }
        create_private_file(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        verify_private(&path).unwrap();
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn new_variant_does_not_replace() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ref.key");
        create_private_file_new(&path, b"first").unwrap();
        let err = create_private_file_new(&path, b"second").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&path).unwrap(), b"first");
        verify_private(&path).unwrap();
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn concurrent_creators_produce_exactly_one_winner() {
        let dir = tempfile::tempdir().unwrap();
        let path = Arc::new(dir.path().join("ref.key"));
        let barrier = Arc::new(Barrier::new(8));
        let handles: Vec<_> = (0..8u8)
            .map(|i| {
                let path = Arc::clone(&path);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    create_private_file_new(&path, &[i; 32]).map(|_| i)
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let winners: Vec<u8> = results
            .iter()
            .filter_map(|r| r.as_ref().ok().copied())
            .collect();
        assert_eq!(winners.len(), 1, "results: {results:?}");
        for r in results.iter().filter(|r| r.is_err()) {
            assert_eq!(r.as_ref().unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        }
        assert_eq!(fs::read(&*path).unwrap(), vec![winners[0]; 32]);
        verify_private(&path).unwrap();
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn refuses_a_directory_target() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("zn.json");
        fs::create_dir(&path).unwrap();
        let err = create_private_file(&path, b"x").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(path.is_dir());
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn refuses_a_path_without_a_file_name() {
        let err = create_private_file(Path::new(""), b"x").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn verify_rejects_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let err = verify_private(&dir.path().join("nope")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    /// Make a link to `target` at `link`; None when the platform or the account
    /// may not create links (Windows without the privilege).
    fn make_link(target: &Path, link: &Path) -> Option<()> {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link).ok()
        }
    }

    #[test]
    fn refuses_a_symlink_target_and_leaves_its_destination_alone() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("victim.txt");
        fs::write(&dest, b"keep me").unwrap();
        let link = dir.path().join("zn.json");
        if make_link(&dest, &link).is_none() {
            eprintln!("skipped: cannot create a symbolic link here");
            return;
        }
        for result in [
            create_private_file(&link, b"attacker data"),
            create_private_file_new(&link, b"attacker data"),
        ] {
            let err = result.unwrap_err();
            assert!(
                matches!(
                    err.kind(),
                    io::ErrorKind::InvalidInput | io::ErrorKind::AlreadyExists
                ),
                "unexpected error: {err}"
            );
        }
        assert_eq!(fs::read(&dest).unwrap(), b"keep me");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            verify_private(&link).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn a_dangling_symlink_is_refused_too() {
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("zn.json");
        let missing = dir.path().join("does-not-exist");
        if make_link(&missing, &link).is_none() {
            eprintln!("skipped: cannot create a symbolic link here");
            return;
        }
        let err = create_private_file(&link, b"x").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(!missing.exists(), "the link destination was created");
    }

    #[test]
    fn read_private_file_returns_the_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ref.key");
        create_private_file_new(&path, b"key-bytes").unwrap();
        assert_eq!(read_private_file(&path).unwrap(), b"key-bytes");
        let mut f = open_private(&path).unwrap();
        let mut s = String::new();
        f.read_to_string(&mut s).unwrap();
        assert_eq!(s, "key-bytes");
    }

    #[test]
    fn read_private_file_reports_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_private_file(&dir.path().join("nope")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn read_private_file_refuses_a_link_and_does_not_read_its_destination() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("dest.key");
        create_private_file(&dest, b"private destination").unwrap();
        let link = dir.path().join("ref.key");
        if make_link(&dest, &link).is_none() {
            eprintln!("skipped: cannot create a symbolic link here");
            return;
        }
        // The destination is perfectly private; only the link must stop the read.
        verify_private(&dest).unwrap();
        for result in [
            read_private_file(&link),
            open_private(&link).map(|_| Vec::new()),
        ] {
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidInput);
        }
    }

    #[test]
    fn read_private_file_refuses_a_dangling_link() {
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("ref.key");
        if make_link(&dir.path().join("missing"), &link).is_none() {
            eprintln!("skipped: cannot create a symbolic link here");
            return;
        }
        let err = read_private_file(&link).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn read_private_file_refuses_a_directory() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("ref.key");
        fs::create_dir(&sub).unwrap();
        // Unix reports a directory as not regular; Windows cannot open it at all.
        assert!(read_private_file(&sub).is_err());
    }

    #[test]
    fn stale_temporary_files_are_removed_and_fresh_ones_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let stale = dir.path().join(".zn-private-4242-7-0000abcd.tmp");
        let fresh = dir.path().join(".zn-private-4243-8-0000abce.tmp");
        let unrelated = dir.path().join(".zn-private-notes.tmp");
        let other = dir.path().join("zn.json");
        for p in [&stale, &fresh, &unrelated, &other] {
            fs::write(p, b"x").unwrap();
        }
        let old = SystemTime::now() - Duration::from_secs(2 * 3600);
        fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert_eq!(remove_stale_temp_files(dir.path()).unwrap(), 1);
        assert!(!stale.exists());
        assert!(fresh.exists() && unrelated.exists() && other.exists());
        // A normal write does the same clean-up on the way.
        fs::File::options()
            .write(true)
            .open(&fresh)
            .unwrap()
            .set_modified(old)
            .unwrap();
        create_private_file(&dir.path().join("a.json"), b"{}").unwrap();
        assert!(!fresh.exists());
        assert!(
            unrelated.exists(),
            "names that are not ours are never touched"
        );
    }

    #[test]
    fn temp_name_shape_matches_what_the_writer_creates() {
        assert!(is_temp_name(".zn-private-12-3-0000ffff.tmp"));
        assert!(!is_temp_name(".zn-private-12-3-0000fffg.tmp"));
        assert!(!is_temp_name(".zn-private-12-3.tmp"));
        assert!(!is_temp_name("zn-private-12-3-0000ffff.tmp"));
        assert!(!is_temp_name(".zn-private-12-3-0000ffff.txt"));
        assert_eq!(TEMP_FILE_PATTERN, ".zn-private-*.tmp");
        // The writer's own names must match the cleaner's shape.
        let dir = tempfile::tempdir().unwrap();
        let (tmp, file) = create_temp(dir.path()).unwrap();
        drop(file);
        assert!(is_temp_name(tmp.file_name().unwrap().to_str().unwrap()));
    }

    #[test]
    fn create_in_place_is_exclusive_and_private() {
        // The fallback used when a file system cannot make hard links.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ref.key");
        create_in_place(&path, b"first").unwrap();
        let err = create_in_place(&path, b"second").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(read_private_file(&path).unwrap(), b"first");
    }

    #[cfg(unix)]
    mod unix_only {
        use super::*;
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        #[test]
        fn mode_is_exactly_0600() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("zn.json");
            create_private_file(&path, b"x").unwrap();
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o7777;
            assert_eq!(mode, 0o600, "mode is {mode:o}");
        }

        #[test]
        fn verify_rejects_group_or_world_access() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("zn.json");
            create_private_file(&path, b"x").unwrap();
            for bad in [
                0o640, 0o604, 0o644, 0o660, 0o666, 0o701, 0o4600, 0o2600, 0o1600,
            ] {
                fs::set_permissions(&path, fs::Permissions::from_mode(bad)).unwrap();
                let err = verify_private(&path).unwrap_err();
                assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "mode {bad:o}");
            }
            // Owner-only modes other than 0600 are accepted: the check is "nothing
            // for group or others and no special bits", as the documentation says.
            for good in [0o400, 0o600, 0o700] {
                fs::set_permissions(&path, fs::Permissions::from_mode(good)).unwrap();
                verify_private(&path).unwrap();
            }
        }

        #[test]
        fn read_private_file_rejects_a_group_or_world_readable_file() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("ref.key");
            create_private_file(&path, b"k").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            let err = read_private_file(&path).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
            assert!(err.to_string().contains("0644"), "{err}");
        }

        #[test]
        fn read_private_file_rejects_a_fifo_without_hanging() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("ref.key");
            let c = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
            // SAFETY: c is a valid NUL-terminated path.
            assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
            let err = read_private_file(&path).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        }

        #[test]
        fn the_file_read_is_the_file_checked() {
            // Swapping the path for a link after the open changes nothing: the
            // bytes come from the descriptor that was checked.
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("ref.key");
            create_private_file(&path, b"checked").unwrap();
            let mut f = open_private(&path).unwrap();
            fs::remove_file(&path).unwrap();
            let evil = dir.path().join("evil");
            fs::write(&evil, b"swapped").unwrap();
            std::os::unix::fs::symlink(&evil, &path).unwrap();
            let mut s = String::new();
            f.read_to_string(&mut s).unwrap();
            assert_eq!(s, "checked");
        }

        #[test]
        fn a_wrong_mode_error_names_the_file_system_cause() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("zn.json");
            create_private_file(&path, b"x").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o777)).unwrap();
            let msg = verify_private(&path).unwrap_err().to_string();
            assert!(msg.contains("0777") && msg.contains("WSL"), "{msg}");
        }

        /// Run with `ZN_PRIVATE_FILE_TEST_NOPERM_DIR` set to a folder on a file
        /// system without Unix permissions (a vfat mount, for example); skipped
        /// otherwise.
        #[test]
        fn a_file_system_without_permissions_gets_a_clear_error() {
            let Some(dir) = std::env::var_os("ZN_PRIVATE_FILE_TEST_NOPERM_DIR") else {
                eprintln!("skipped: ZN_PRIVATE_FILE_TEST_NOPERM_DIR is not set");
                return;
            };
            let dir = PathBuf::from(dir);
            for result in [
                create_private_file(&dir.join("zn.json"), b"x"),
                create_private_file_new(&dir.join("ref.key"), b"x"),
            ] {
                let err = result.unwrap_err();
                assert_eq!(err.kind(), io::ErrorKind::Unsupported, "{err}");
                assert!(err.to_string().contains("does not keep Unix permissions"));
            }
            assert!(!dir.join("zn.json").exists() && !dir.join("ref.key").exists());
            assert!(leftovers(&dir).is_empty(), "temporary file left behind");
            println!("NOPERM_CHECKED");
        }

        #[test]
        fn hard_link_errors_that_trigger_the_fallback() {
            for code in [libc::EPERM, libc::ENOTSUP, libc::ENOSYS] {
                assert!(sys::hard_link_unsupported(&io::Error::from_raw_os_error(
                    code
                )));
            }
            for code in [libc::EEXIST, libc::EACCES, libc::ENOSPC] {
                assert!(!sys::hard_link_unsupported(&io::Error::from_raw_os_error(
                    code
                )));
            }
        }

        fn umask_roundtrip(mask: libc::mode_t) {
            let dir = tempfile::tempdir().unwrap();
            // SAFETY: umask only changes this (child) process.
            unsafe { libc::umask(mask) };
            let a = dir.path().join("a.json");
            let b = dir.path().join("b.key");
            create_private_file(&a, b"x").unwrap();
            create_private_file_new(&b, b"x").unwrap();
            for p in [&a, &b] {
                let mode = fs::metadata(p).unwrap().permissions().mode() & 0o7777;
                assert_eq!(mode, 0o600, "umask {mask:03o}: mode {mode:o}");
                read_private_file(p).unwrap();
            }
            println!("UMASK_CHILD_OK {mask:03o}");
        }

        /// Does something only in the child process started by `modes_ignore_the_umask`.
        #[test]
        fn umask_child() {
            if let Some(m) = std::env::var_os("ZN_PRIVATE_FILE_UMASK_CHILD") {
                let mask = u32::from_str_radix(m.to_str().unwrap(), 8).unwrap();
                umask_roundtrip(mask as libc::mode_t);
            }
        }

        #[test]
        fn modes_ignore_the_umask() {
            // The umask is per process, so each value runs in its own process.
            let exe = std::env::current_exe().unwrap();
            for mask in ["000", "077", "277"] {
                let out = std::process::Command::new(&exe)
                    .args([
                        "--exact",
                        "private_file::tests::unix_only::umask_child",
                        "--nocapture",
                        "--test-threads=1",
                    ])
                    .env("ZN_PRIVATE_FILE_UMASK_CHILD", mask)
                    .output()
                    .unwrap();
                let stdout = String::from_utf8_lossy(&out.stdout);
                assert!(
                    out.status.success() && stdout.contains(&format!("UMASK_CHILD_OK {mask}")),
                    "umask {mask}: {stdout}\n{}",
                    String::from_utf8_lossy(&out.stderr)
                );
            }
        }

        #[test]
        fn the_new_file_is_a_different_inode_than_the_replaced_one() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("zn.json");
            create_private_file(&path, b"one").unwrap();
            let first = fs::metadata(&path).unwrap().ino();
            create_private_file(&path, b"two").unwrap();
            assert_ne!(first, fs::metadata(&path).unwrap().ino());
        }

        #[test]
        fn another_hard_link_to_the_old_file_keeps_the_old_content() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("zn.json");
            let other = dir.path().join("other-name");
            fs::write(&path, b"old").unwrap();
            fs::hard_link(&path, &other).unwrap();
            create_private_file(&path, b"new").unwrap();
            assert_eq!(fs::read(&path).unwrap(), b"new");
            assert_eq!(fs::read(&other).unwrap(), b"old");
        }

        #[test]
        fn a_folder_that_cannot_be_written_gives_a_clean_error() {
            // A file written in a folder the process cannot write to gets an
            // error and no partial file.
            let dir = tempfile::tempdir().unwrap();
            let sub = dir.path().join("locked");
            fs::create_dir(&sub).unwrap();
            fs::set_permissions(&sub, fs::Permissions::from_mode(0o500)).unwrap();
            let result = create_private_file(&sub.join("zn.json"), b"x");
            fs::set_permissions(&sub, fs::Permissions::from_mode(0o700)).unwrap();
            // Running as root ignores directory permissions; otherwise it must fail.
            if unsafe { libc::geteuid() } != 0 {
                assert!(result.is_err());
            }
            assert!(!sub.join("zn.json").exists() || result.is_ok());
            assert!(leftovers(&sub).is_empty());
        }
    }

    #[cfg(windows)]
    mod windows_only {
        use super::*;
        use std::process::Command;

        /// Entries printed by `icacls` for one file: lines holding `:(`.
        fn icacls_entries(path: &Path) -> Vec<String> {
            let out = Command::new("icacls")
                .arg(path)
                .output()
                .expect("run icacls");
            assert!(out.status.success(), "icacls failed: {out:?}");
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter(|l| l.contains(":("))
                .map(|l| l.trim().to_string())
                .collect()
        }

        #[test]
        fn a_new_private_file_has_one_explicit_entry_and_passes_the_check() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("zn.json");
            create_private_file(&path, b"{}").unwrap();
            verify_private(&path).unwrap();
            let entries = icacls_entries(&path);
            assert_eq!(entries.len(), 1, "icacls shows: {entries:?}");
            assert!(!entries[0].contains("(I)"), "inherited entry: {entries:?}");
            assert!(entries[0].contains("(F)"), "not full control: {entries:?}");
        }

        #[test]
        fn an_ordinary_file_in_a_normal_folder_is_not_private() {
            // Files made with std::fs inherit the folder's entries (the user,
            // Administrators and SYSTEM at least): the check must say so.
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("plain.json");
            fs::write(&path, b"{}").unwrap();
            let err = verify_private(&path).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "{err}");
        }

        #[test]
        fn a_file_with_an_extra_entry_is_rejected_after_being_widened() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("zn.json");
            create_private_file(&path, b"{}").unwrap();
            verify_private(&path).unwrap();
            // Add read access for Everyone (S-1-1-0): the check must fail.
            let st = Command::new("icacls")
                .arg(&path)
                .args(["/grant", "*S-1-1-0:(R)"])
                .output()
                .expect("run icacls");
            assert!(st.status.success(), "icacls grant failed: {st:?}");
            let err = verify_private(&path).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "{err}");
        }

        #[test]
        fn read_private_file_reads_an_owner_only_file_and_rejects_others() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("ref.key");
            create_private_file_new(&path, b"key-bytes").unwrap();
            assert_eq!(read_private_file(&path).unwrap(), b"key-bytes");
            let plain = dir.path().join("plain.key");
            fs::write(&plain, b"x").unwrap();
            let err = read_private_file(&plain).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "{err}");
            // Widened after creation: rejected on the handle that was opened.
            let st = Command::new("icacls")
                .arg(&path)
                .args(["/grant", "*S-1-1-0:(R)"])
                .output()
                .expect("run icacls");
            assert!(st.status.success(), "icacls grant failed: {st:?}");
            let err = read_private_file(&path).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "{err}");
        }

        #[test]
        fn a_reparse_point_is_refused_by_the_attribute_check_and_not_followed() {
            // A private file behind a link: the link is what is refused, even
            // though its destination would pass every other check.
            let dir = tempfile::tempdir().unwrap();
            let dest = dir.path().join("dest.key");
            create_private_file(&dest, b"private destination").unwrap();
            let link = dir.path().join("ref.key");
            if make_link(&dest, &link).is_none() {
                eprintln!("skipped: cannot create a symbolic link here");
                return;
            }
            let err = read_private_file(&link).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::InvalidInput, "{err}");
            assert!(err.to_string().contains("link"), "{err}");
            println!("REPARSE_REFUSED");
        }

        #[test]
        fn retry_busy_retries_busy_errors_and_nothing_else() {
            use std::cell::Cell;
            let calls = Cell::new(0);
            let busy = |code: u32, fail: u32| {
                calls.set(0);
                super::sys::retry_busy(&[1, 1, 1], || {
                    calls.set(calls.get() + 1);
                    if calls.get() <= fail {
                        Err(io::Error::from_raw_os_error(code as i32))
                    } else {
                        Ok(calls.get())
                    }
                })
            };
            assert_eq!(busy(32, 2).unwrap(), 3); // sharing violation, then fine
            assert_eq!(busy(5, 3).unwrap(), 4); // access denied, then fine
            assert!(busy(32, 99).is_err());
            assert_eq!(calls.get(), 4, "one try plus three retries");
            assert!(busy(2, 99).is_err()); // file not found: no retry
            assert_eq!(calls.get(), 1);
        }

        #[test]
        fn replacing_a_file_that_is_briefly_open_succeeds_after_a_retry() {
            use std::os::windows::fs::OpenOptionsExt;
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("zn.json");
            create_private_file(&path, b"old").unwrap();
            // Another program holds the target open without sharing for a moment.
            let holder = fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&path)
                .unwrap();
            let release = std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(150));
                drop(holder);
            });
            create_private_file(&path, b"new").unwrap();
            release.join().unwrap();
            assert_eq!(read_private_file(&path).unwrap(), b"new");
            assert!(leftovers(dir.path()).is_empty());
        }

        #[test]
        fn replacing_a_file_keeps_it_private() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("zn.json");
            fs::write(&path, b"plain, inherited entries").unwrap();
            create_private_file(&path, b"private").unwrap();
            assert_eq!(fs::read(&path).unwrap(), b"private");
            verify_private(&path).unwrap();
            assert_eq!(icacls_entries(&path).len(), 1);
        }
    }
}
