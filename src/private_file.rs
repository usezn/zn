//! Writing files that only their owner can read.
//!
//! `zn init` writes `zn.json` and the audit code writes `ref.key`. Both can hold
//! material that other local accounts must not read, so they are created through
//! this module instead of `std::fs::write`.
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
//! - Unix: mode `0600` (exactly, whatever the umask), opened with `O_EXCL` and
//!   `O_NOFOLLOW`; the owner must be the effective user.
//! - Windows: the file is created with a security descriptor that makes the
//!   current user the owner and grants full control to that user only, with a
//!   protected DACL (no inherited entries, no SYSTEM, no Administrators). The
//!   descriptor is passed to `CreateFileW`, so it applies from the first moment.
//!   [`verify_private`] reads it back and accepts nothing else.
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

use std::fs::{self, File, Metadata};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

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

/// Check that `path` is a regular file (not a link) that only its owner can
/// access: mode `0600` and owned by the effective user on Unix; owned by the
/// current user with a protected DACL that has no entry for anybody else on
/// Windows. Returns [`io::ErrorKind::PermissionDenied`] when it is not.
pub fn verify_private(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    require_regular(&meta, path)?;
    sys::verify_path(path, &meta)
}

fn denied(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, msg)
}

fn require_regular(meta: &Metadata, path: &Path) -> io::Result<()> {
    if meta.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("refusing to write through a link: {}", path.display()),
        ));
    }
    if !meta.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("not a regular file: {}", path.display()),
        ));
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
    let installed = sys::install(&tmp, path, replace);
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

fn create_temp(dir: &Path) -> io::Result<(PathBuf, File)> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    for _ in 0..16 {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let tmp = dir.join(format!(
            ".zn-private-{}-{}-{:08x}.tmp",
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
    use super::denied;
    use std::fs::{self, File, Metadata, OpenOptions, Permissions};
    use std::io;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::Path;

    pub fn create_new_private(path: &Path) -> io::Result<File> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)?;
        // The umask can only remove bits, but make the mode exact anyway.
        file.set_permissions(Permissions::from_mode(0o600))?;
        Ok(file)
    }

    pub fn verify_file(file: &File) -> io::Result<()> {
        check(&file.metadata()?)
    }

    pub fn verify_path(_path: &Path, meta: &Metadata) -> io::Result<()> {
        check(meta)
    }

    fn check(meta: &Metadata) -> io::Result<()> {
        let mode = meta.mode() & 0o7777;
        if mode & 0o077 != 0 {
            return Err(denied(format!(
                "file mode is {:04o}, expected 0600 (no access for group or others)",
                mode
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

    pub fn sync_dir(dir: &Path) {
        if let Ok(d) = File::open(dir) {
            let _ = d.sync_all();
        }
    }
}

#[cfg(windows)]
mod sys {
    use super::denied;
    use std::ffi::{c_void, OsStr};
    use std::fs::{self, File, Metadata};
    use std::io;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
    use std::path::Path;
    use std::ptr::{addr_of, null, null_mut};

    use windows_sys::Win32::Foundation::{
        CloseHandle, LocalFree, HANDLE, HLOCAL, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        GetNamedSecurityInfoW, GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        AclSizeInformation, CopySid, EqualSid, GetAce, GetAclInformation, GetLengthSid,
        GetSecurityDescriptorControl, GetTokenInformation, IsValidSid, TokenUser,
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, MoveFileExW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_WRITE,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // Values fixed by the Win32 ABI (winnt.h).
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const INHERITED_ACE: u8 = 0x10;
    const SE_DACL_PRESENT: u16 = 0x0004;
    const SE_DACL_PROTECTED: u16 = 0x1000;

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
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
        // access (FA) for the user. Nothing for SYSTEM, Administrators or anyone else.
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

    pub fn verify_path(path: &Path, _meta: &Metadata) -> io::Result<()> {
        let name = wide(path);
        let mut owner: PSID = null_mut();
        let mut dacl: *mut ACL = null_mut();
        let mut psd: PSECURITY_DESCRIPTOR = null_mut();
        // SAFETY: as in verify_file.
        let rc = unsafe {
            GetNamedSecurityInfoW(
                name.as_ptr(),
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
        // SAFETY: psd was allocated by GetNamedSecurityInfoW.
        unsafe { LocalFree(psd as HLOCAL) };
        result
    }

    /// Fail closed unless: the owner is the current user, the DACL is present and
    /// protected, and every entry is an explicit (not inherited) allow entry for
    /// the current user, with at least one entry.
    fn check(owner: PSID, dacl: *mut ACL, psd: PSECURITY_DESCRIPTOR) -> io::Result<()> {
        let me = UserSid::current()?;
        // SAFETY: owner, dacl and psd come from a successful GetSecurityInfo or
        // GetNamedSecurityInfoW call and stay valid until the caller frees psd;
        // ACE pointers point inside the DACL.
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
            fs::rename(tmp, path)
        } else {
            // No MOVEFILE_REPLACE_EXISTING: fails with AlreadyExists when the
            // target is there, atomically, on any file system.
            let from = wide(tmp);
            let to = wide(path);
            // SAFETY: both buffers are NUL-terminated and outlive the call.
            if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }
    }

    pub fn sync_dir(_dir: &Path) {}

    #[allow(dead_code)]
    fn _unused(_: *const c_void) {
        let _ = null::<c_void>();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
            for bad in [0o640, 0o604, 0o644, 0o660, 0o666, 0o700 | 0o001] {
                fs::set_permissions(&path, fs::Permissions::from_mode(bad)).unwrap();
                let err = verify_private(&path).unwrap_err();
                assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "mode {bad:o}");
            }
            fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
            verify_private(&path).unwrap();
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
        fn works_with_a_restrictive_umask_free_mode() {
            // A file written in a folder the process cannot list still gets a
            // clean error instead of a partial file.
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
