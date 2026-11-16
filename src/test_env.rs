//! Test helper: HOME and USERPROFILE are process-wide, so every test that sets
//! or reads them (directly, or through `expand_tilde` and `shared_engine`)
//! takes this one lock first.

use std::ffi::OsString;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

static HOME_LOCK: Mutex<()> = Mutex::new(());

/// Holds the lock and restores both variables when dropped.
pub(crate) struct HomeGuard {
    home: Option<OsString>,
    profile: Option<OsString>,
    _lock: MutexGuard<'static, ()>,
}

impl HomeGuard {
    fn lock() -> Self {
        let lock = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        HomeGuard {
            home: std::env::var_os("HOME"),
            profile: std::env::var_os("USERPROFILE"),
            _lock: lock,
        }
    }

    /// For a test that only reads the variables: nobody changes them meanwhile.
    pub(crate) fn read() -> Self {
        Self::lock()
    }

    /// Set HOME (or remove it) and remove USERPROFILE.
    pub(crate) fn set(home: Option<&Path>) -> Self {
        let guard = Self::lock();
        std::env::remove_var("USERPROFILE");
        match home {
            Some(p) => std::env::set_var("HOME", p),
            None => std::env::remove_var("HOME"),
        }
        guard
    }

    /// Set USERPROFILE as well (for a test of which variable wins).
    pub(crate) fn set_profile(&self, profile: &Path) {
        std::env::set_var("USERPROFILE", profile);
    }
}

impl Drop for HomeGuard {
    fn drop(&mut self) {
        match &self.home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        match &self.profile {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
        }
    }
}
