//! WASM Policy Engine Module
//!
//! Provides secure execution of WASM-based security policies with:
//! - Gas metering to prevent infinite loops
//! - Policy integrity verification via SHA-256 hashes
//! - Memory-safe communication with WASM modules

pub mod cache;
pub mod consensus;
pub mod loop_breaker;
pub mod neural;
pub mod policy_file;
pub mod reputation;
pub mod rules;
pub mod signing;
pub mod sync;
pub mod vision;
pub mod watcher;

use anyhow::{anyhow, Result};
use dashmap::DashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::{error, info, warn};
use wasmtime::*;

pub use policy_file::write_policy_file;

/// Longest policy name accepted by the management API.
pub const MAX_POLICY_NAME_LEN: usize = 64;

/// True when `name` can name a policy file: 1 to `MAX_POLICY_NAME_LEN`
/// ASCII letters, digits, `.`, `-` or `_`, starting with a letter or digit.
/// Path separators, `..` and every other character are rejected, so the
/// name can never point outside the policy directory.
pub fn valid_policy_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_POLICY_NAME_LEN
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

fn invalid_policy_name_error() -> anyhow::Error {
    anyhow!(
        "Invalid policy name: use 1-{} letters, digits, '.', '-' or '_', starting with a letter or digit",
        MAX_POLICY_NAME_LEN
    )
}

/// Path of the `<name>.wasm` file of a policy inside `dir`, for the
/// management API's upload endpoint.
///
/// Fails when `name` is not a valid policy name, or when the resolved path
/// (following a symlink already at that place) is not directly inside `dir`.
/// Creates `dir` if it does not exist.
pub fn policy_file_path(dir: impl AsRef<Path>, name: &str) -> Result<PathBuf> {
    if !valid_policy_name(name) {
        return Err(invalid_policy_name_error());
    }
    let dir = dir.as_ref();
    std::fs::create_dir_all(dir)
        .map_err(|e| anyhow!("Failed to create policy directory {:?}: {}", dir, e))?;
    let base = dir
        .canonicalize()
        .map_err(|e| anyhow!("Failed to resolve policy directory {:?}: {}", dir, e))?;
    let path = base.join(format!("{}.wasm", name));
    let resolved = match path.canonicalize() {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => path.clone(),
        Err(e) => return Err(anyhow!("Failed to resolve policy file {:?}: {}", path, e)),
    };
    if resolved.parent() != Some(base.as_path()) || !resolved.starts_with(&base) {
        return Err(anyhow!("Policy file must be inside the policy directory"));
    }
    Ok(path)
}

/// Deletes the `<name>.wasm` file of a policy, for the management API's
/// delete endpoint. Returns `Ok(false)` when there is no such file.
///
/// The file is looked up by listing `dir` and comparing each entry's file
/// name with `<name>.wasm`; the path that is removed is the one from the
/// listing, never one built from `name`. Fails when `name` is not a valid
/// policy name, or when the entry is a symlink or not a regular file.
pub fn remove_policy_file(dir: impl AsRef<Path>, name: &str) -> Result<bool> {
    if !valid_policy_name(name) {
        return Err(invalid_policy_name_error());
    }
    let dir = dir.as_ref();
    let base = match dir.canonicalize() {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => {
            return Err(anyhow!(
                "Failed to resolve policy directory {:?}: {}",
                dir,
                e
            ))
        }
    };
    let wanted = std::ffi::OsString::from(format!("{}.wasm", name));
    let entries = std::fs::read_dir(&base)
        .map_err(|e| anyhow!("Failed to list policy directory {:?}: {}", base, e))?;
    for entry in entries {
        let entry =
            entry.map_err(|e| anyhow!("Failed to list policy directory {:?}: {}", base, e))?;
        if entry.file_name() != wanted {
            continue;
        }
        let path = entry.path();
        if path.parent() != Some(base.as_path()) {
            return Err(anyhow!("Policy file must be inside the policy directory"));
        }
        // symlink_metadata never follows a symlink, so a link (even a
        // dangling one) is seen as a link and refused.
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|e| anyhow!("Failed to read policy file {:?}: {}", path, e))?;
        if meta.file_type().is_symlink() {
            return Err(anyhow!("Policy file {:?} is a symlink", path));
        }
        if !meta.is_file() {
            return Err(anyhow!("Policy file {:?} is not a regular file", path));
        }
        std::fs::remove_file(&path).map_err(|e| anyhow!("Failed to delete policy file: {}", e))?;
        return Ok(true);
    }
    Ok(false)
}

struct ZnContext {
    memory_limit: usize,
    agent_id: Option<String>,
    state_store: Arc<DashMap<String, String>>,
}

impl ResourceLimiter for ZnContext {
    fn memory_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        Ok(desired <= self.memory_limit)
    }

    fn table_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> wasmtime::Result<bool> {
        Ok(desired <= 1000)
    }
}

/// Configuration for the Zn Engine
pub struct ZnEngineConfig {
    /// Maximum fuel (gas) units for WASM execution
    pub gas_limit: u64,
    /// Maximum memory in bytes
    pub memory_limit: u64,
    /// Execution timeout in milliseconds
    pub timeout_ms: u64,
    /// Whitelist of allowed policy SHA-256 hashes (hex-encoded)
    /// If empty, all policies are allowed (not recommended for production)
    pub allowed_hashes: Vec<String>,
    /// Public key for Ed25519 signature verification (hex)
    pub signing_public_key: Option<String>,
}

/// Why a policy keeps the engine failing closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyFault {
    /// The `.wasm` file exists but did not load (bad hash, signature or contents).
    LoadFailed(String),
    /// A registered policy's file was removed from the policy directory.
    FileRemoved,
}

impl std::fmt::Display for PolicyFault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PolicyFault::LoadFailed(e) => write!(f, "failed to load: {}", e),
            PolicyFault::FileRemoved => write!(f, "policy file removed"),
        }
    }
}

/// WASM Policy Execution Engine
pub struct ZnEngine {
    engine: Engine,
    linker: Linker<ZnContext>,
    config: ZnEngineConfig,
    /// Registry of loaded policies (name -> Module)
    policies: DashMap<String, Arc<Module>>,
    /// Policies that could not be loaded, or whose file was removed, by name.
    /// While any entry exists the engine fails closed: every tool call is denied.
    faults: DashMap<String, PolicyFault>,
    /// Policy signature verifier
    verifier: signing::PolicyVerifier,
    /// Shared state store for policies
    state_store: Arc<DashMap<String, String>>,
}

impl ZnEngine {
    /// Create a new ZnEngine with the given configuration
    pub fn new(config: ZnEngineConfig) -> Result<Self> {
        let mut wasm_config = Config::new();
        wasm_config.consume_fuel(true);
        wasm_config.epoch_interruption(true);

        let engine = Engine::new(&wasm_config)?;

        // Start epoch ticker for timeouts
        let engine_for_ticker = engine.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(100)); // 100ms ticks
                engine_for_ticker.increment_epoch();
            }
        });

        let mut linker = Linker::<ZnContext>::new(&engine);
        let state_store = Arc::new(DashMap::new());

        // --- Host Functions ---

        // fn zn_state_set(key_ptr, key_len, val_ptr, val_len)
        linker.func_wrap(
            "env",
            "zn_state_set",
            move |mut caller: Caller<'_, ZnContext>,
                  k_ptr: u32,
                  k_len: u32,
                  v_ptr: u32,
                  v_len: u32| {
                let memory = match caller.get_export("memory") {
                    Some(Extern::Memory(m)) => m,
                    _ => return,
                };

                let mut key_buf = vec![0u8; k_len as usize];
                let mut val_buf = vec![0u8; v_len as usize];

                if memory.read(&caller, k_ptr as usize, &mut key_buf).is_ok()
                    && memory.read(&caller, v_ptr as usize, &mut val_buf).is_ok()
                {
                    if let (Ok(key), Ok(val)) =
                        (String::from_utf8(key_buf), String::from_utf8(val_buf))
                    {
                        caller.data().state_store.insert(key, val);
                    }
                }
            },
        )?;

        // fn zn_state_get(key_ptr, key_len, val_ptr, val_max_len) -> actual_len
        linker.func_wrap(
            "env",
            "zn_state_get",
            move |mut caller: Caller<'_, ZnContext>,
                  k_ptr: u32,
                  k_len: u32,
                  v_ptr: u32,
                  v_max_len: u32|
                  -> u32 {
                let memory = match caller.get_export("memory") {
                    Some(Extern::Memory(m)) => m,
                    _ => return 0,
                };

                let mut key_buf = vec![0u8; k_len as usize];
                if memory.read(&caller, k_ptr as usize, &mut key_buf).is_err() {
                    return 0;
                }

                let key = match String::from_utf8(key_buf) {
                    Ok(k) => k,
                    Err(_) => return 0,
                };

                // Copy value out of DashMap to avoid borrow conflicts
                let val_opt = caller.data().state_store.get(&key).map(|v| v.clone());

                if let Some(val) = val_opt {
                    let val_bytes = val.as_bytes();
                    let len = val_bytes.len() as u32;
                    let write_len = len.min(v_max_len);
                    if memory
                        .write(
                            &mut caller,
                            v_ptr as usize,
                            &val_bytes[..write_len as usize],
                        )
                        .is_ok()
                    {
                        return len;
                    }
                }
                0
            },
        )?;

        // fn zn_get_agent_id(ptr, max_len) -> actual_len
        linker.func_wrap(
            "env",
            "zn_get_agent_id",
            move |mut caller: Caller<'_, ZnContext>, ptr: u32, max_len: u32| -> u32 {
                let memory = match caller.get_export("memory") {
                    Some(Extern::Memory(m)) => m,
                    _ => return 0,
                };

                let agent_id_opt = caller.data().agent_id.clone();

                if let Some(agent_id) = agent_id_opt {
                    let bytes = agent_id.as_bytes();
                    let len = bytes.len() as u32;
                    let write_len = len.min(max_len);
                    if memory
                        .write(&mut caller, ptr as usize, &bytes[..write_len as usize])
                        .is_ok()
                    {
                        return len;
                    }
                }
                0
            },
        )?;

        if config.allowed_hashes.is_empty() {
            warn!("No allowed policy hashes configured - all policies will be accepted");
        } else {
            info!(
                "Policy engine initialized with {} allowed hashes",
                config.allowed_hashes.len()
            );
        }

        let verifier = signing::PolicyVerifier::new(config.signing_public_key.as_deref())?;

        Ok(Self {
            engine,
            linker,
            config,
            policies: DashMap::new(),
            faults: DashMap::new(),
            verifier,
            state_store,
        })
    }

    /// Compute SHA-256 hash of data and return hex-encoded string
    fn compute_hash(data: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(data);
        let result = hasher.finalize();
        hex::encode(result)
    }

    /// Verify policy integrity against allowed hashes
    fn verify_policy_integrity(&self, bytes: &[u8], path: &Path) -> Result<()> {
        if self.config.allowed_hashes.is_empty() {
            // No hash verification configured - allow all policies
            return Ok(());
        }

        let hash = Self::compute_hash(bytes);
        info!("Policy hash for {:?}: {}", path, hash);

        if self.config.allowed_hashes.contains(&hash) {
            info!("Policy {:?} passed integrity check", path);
            Ok(())
        } else {
            error!(
                "Policy {:?} failed integrity check. Hash {} not in allowed list",
                path, hash
            );
            Err(anyhow!(
                "Policy integrity check failed: hash {} not allowed",
                hash
            ))
        }
    }

    /// Load and register a WASM policy from file with integrity verification.
    ///
    /// A failure is recorded: the engine denies every tool call until the
    /// policy loads or its file is removed through `unregister_policy`.
    pub fn register_policy_from_file(&self, path: impl AsRef<Path>) -> Result<()> {
        let path = path.as_ref();
        let result = self.load_policy_file(path);
        if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
            match &result {
                Ok(()) => {
                    self.faults.remove(name);
                }
                Err(e) => {
                    self.faults
                        .insert(name.to_string(), PolicyFault::LoadFailed(e.to_string()));
                }
            }
        }
        result
    }

    fn load_policy_file(&self, path: &Path) -> Result<()> {
        let name = path
            .file_stem()
            .and_then(|s: &std::ffi::OsStr| s.to_str())
            .ok_or_else(|| anyhow!("Invalid policy filename"))?
            .to_string();

        let bytes = std::fs::read(path)
            .map_err(|e| anyhow!("Failed to read policy file {:?}: {}", path, e))?;

        // Verify integrity before loading
        self.verify_policy_integrity(&bytes, path)?;

        // Verify cryptographic signature if public key is configured
        self.verifier.verify(&bytes, path)?;

        let module = Module::new(&self.engine, bytes)
            .map_err(|e| anyhow!("Failed to compile WASM policy {:?}: {}", path, e))?;

        self.policies.insert(name.clone(), Arc::new(module));
        info!("Registered policy: {}", name);
        Ok(())
    }

    /// Verify an uploaded policy and only then save it and register it.
    ///
    /// The checks run on the bytes in memory: the allowed-hash list, the
    /// Ed25519 signature and, when `ZN_PQ_PUBLIC_KEY` is set, the ML-DSA-65
    /// signature (read from the `.wasm.sig` and `.wasm.pqs` files next to
    /// `path`), then the WASM must compile. Nothing is written when a check
    /// fails, and a policy that already exists at `path` stays as it was.
    pub fn install_policy(&self, path: impl AsRef<Path>, bytes: &[u8]) -> Result<()> {
        let path = path.as_ref();
        let name = path
            .file_stem()
            .and_then(|s: &std::ffi::OsStr| s.to_str())
            .ok_or_else(|| anyhow!("Invalid policy filename"))?
            .to_string();

        self.verify_policy_integrity(bytes, path)?;

        let mut module = None;
        self.verifier.verify_then_write(bytes, path, |b| {
            module = Some(
                Module::new(&self.engine, b)
                    .map_err(|e| anyhow!("Failed to compile WASM policy {:?}: {}", path, e))?,
            );
            Ok(())
        })?;

        if let Some(module) = module {
            self.policies.insert(name.clone(), Arc::new(module));
            self.faults.remove(&name);
            info!("Registered policy: {}", name);
        }
        Ok(())
    }

    /// Registered policy count
    pub fn policy_count(&self) -> usize {
        self.policies.len()
    }

    /// Load all policies from a directory
    pub fn load_all_policies(&self, dir: impl AsRef<Path>) -> Result<()> {
        let dir = dir.as_ref();
        if !dir.exists() {
            std::fs::create_dir_all(dir)?;
        }

        for entry in walkdir::WalkDir::new(dir).max_depth(1) {
            let entry = entry?;
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "wasm") {
                if let Err(e) = self.register_policy_from_file(path) {
                    error!("Failed to load policy {:?}: {}", path, e);
                }
            }
        }
        Ok(())
    }

    /// Unregister a policy by name. This is the deliberate path (the management
    /// API's delete): it also clears any fault recorded for that name.
    pub fn unregister_policy(&self, name: &str) {
        if self.policies.remove(name).is_some() {
            info!("Unregistered policy: {}", name);
        }
        self.faults.remove(name);
    }

    /// A policy file disappeared from the policy directory (seen by the
    /// watcher). A registered policy that vanishes fails the engine closed
    /// instead of silently shrinking the set; a file that never loaded just
    /// stops being a problem.
    pub fn policy_file_removed(&self, name: &str) {
        if self.policies.contains_key(name) {
            warn!("Policy file removed: {} - failing closed", name);
            // Record the fault before dropping the policy, so no call can see
            // an empty set that is not marked as failing.
            self.faults
                .insert(name.to_string(), PolicyFault::FileRemoved);
            self.policies.remove(name);
        } else if matches!(
            self.faults.get(name).map(|f| f.clone()),
            Some(PolicyFault::LoadFailed(_))
        ) {
            self.faults.remove(name);
        }
    }

    /// Policies that keep the engine failing closed, as `(name, reason)`.
    pub fn policy_faults(&self) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = self
            .faults
            .iter()
            .map(|e| (e.key().clone(), e.value().to_string()))
            .collect();
        v.sort();
        v
    }

    /// True when a policy failed to load or was removed, so every call is denied.
    pub fn is_failing_closed(&self) -> bool {
        !self.faults.is_empty()
    }

    /// Get a policy by name
    pub fn _get_policy(&self, name: &str) -> Option<Arc<Module>> {
        self.policies.get(name).map(|m| Arc::clone(&m))
    }

    /// Check if target policy exists
    pub fn _has_policy(&self, name: &str) -> bool {
        self.policies.contains_key(name)
    }

    /// List all registered policies
    pub fn list_policies(&self) -> Vec<String> {
        self.policies
            .iter()
            .map(|entry| entry.key().clone())
            .collect()
    }

    /// Check a tool call against all registered policies
    /// Returns true only if ALL policies allow it.
    pub fn check_tool_call_all(
        &self,
        tool_name: &str,
        arguments: &str,
        agent_id: Option<String>,
    ) -> Result<bool> {
        if self.is_failing_closed() {
            warn!(
                "Denying tool call {}: policy fault(s): {:?}",
                tool_name,
                self.policy_faults()
            );
            return Ok(false);
        }

        if self.policies.is_empty() {
            // No policies configured = allow (default behavior)
            return Ok(true);
        }

        for entry in self.policies.iter() {
            let policy_name = entry.key();
            let module = entry.value();
            if !self.check_tool_call(module, tool_name, arguments, agent_id.clone())? {
                warn!("Policy '{}' DENIED tool call: {}", policy_name, tool_name);
                return Ok(false);
            }
        }

        Ok(true)
    }

    /// Load a policy from bytes (for testing or embedded policies)
    pub fn _load_policy_from_bytes(&self, bytes: &[u8], name: &str) -> Result<Module> {
        if !self.config.allowed_hashes.is_empty() {
            let hash = Self::compute_hash(bytes);
            if !self.config.allowed_hashes.contains(&hash) {
                return Err(anyhow!(
                    "Policy '{}' integrity check failed: hash {} not allowed",
                    name,
                    hash
                ));
            }
        }

        Module::new(&self.engine, bytes)
            .map_err(|e| anyhow!("Failed to compile WASM policy '{}': {}", name, e))
    }

    /// Check a tool call against a loaded policy module with optional agent identity
    ///
    /// Returns `true` if the tool call is allowed, `false` if denied.
    pub fn check_tool_call(
        &self,
        module: &Module,
        tool_name: &str,
        arguments: &str,
        agent_id: Option<String>,
    ) -> Result<bool> {
        let context = ZnContext {
            memory_limit: self.config.memory_limit as usize,
            agent_id,
            state_store: Arc::clone(&self.state_store),
        };
        let mut store = Store::new(&self.engine, context);
        store.limiter(|s| s);
        store.set_fuel(self.config.gas_limit)?;

        // Set timeout deadline (timeout_ms / 100ms per tick)
        let ticks = (self.config.timeout_ms / 100).max(1);
        store.set_epoch_deadline(ticks);

        let instance = self.linker.instantiate(&mut store, module)?;

        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or_else(|| anyhow!("Failed to find memory export"))?;

        let alloc = instance.get_typed_func::<u32, u32>(&mut store, "alloc")?;
        let dealloc = instance.get_typed_func::<(u32, u32), ()>(&mut store, "dealloc")?;
        let validate = instance
            .get_typed_func::<(u32, u32, u32, u32), i32>(&mut store, "validate_tool_call")?;

        // Write strings to WASM memory
        let name_bytes = tool_name.as_bytes();
        let name_len = name_bytes.len() as u32;
        let name_ptr = alloc.call(&mut store, name_len)?;

        // Check for allocation failure
        if name_ptr == 0 {
            return Err(anyhow!("WASM memory allocation failed for tool name"));
        }
        memory.write(&mut store, name_ptr as usize, name_bytes)?;

        let args_bytes = arguments.as_bytes();
        let args_len = args_bytes.len() as u32;
        let args_ptr = alloc.call(&mut store, args_len)?;

        // Check for allocation failure
        if args_ptr == 0 {
            // Cleanup name allocation before returning error
            let _ = dealloc.call(&mut store, (name_ptr, name_len));
            return Err(anyhow!("WASM memory allocation failed for arguments"));
        }
        memory.write(&mut store, args_ptr as usize, args_bytes)?;

        // Call the validation function
        let result = validate.call(&mut store, (name_ptr, name_len, args_ptr, args_len))?;

        // Cleanup memory
        let _ = dealloc.call(&mut store, (name_ptr, name_len));
        let _ = dealloc.call(&mut store, (args_ptr, args_len));

        // Log gas consumption for monitoring
        if let Ok(remaining) = store.get_fuel() {
            let consumed = self.config.gas_limit.saturating_sub(remaining);
            if consumed > self.config.gas_limit / 2 {
                warn!(
                    "High gas consumption for tool '{}': {} / {}",
                    tool_name, consumed, self.config.gas_limit
                );
            }
        }

        Ok(result == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_hash_consistency() {
        let data = b"test policy content";
        let hash1 = ZnEngine::compute_hash(data);
        let hash2 = ZnEngine::compute_hash(data);
        assert_eq!(hash1, hash2);
    }

    #[test]
    fn test_compute_hash_different_data() {
        let hash1 = ZnEngine::compute_hash(b"data1");
        let hash2 = ZnEngine::compute_hash(b"data2");
        assert_ne!(hash1, hash2);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zn-policy-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn policy_names_that_could_leave_the_directory_are_rejected() {
        let too_long = "a".repeat(MAX_POLICY_NAME_LEN + 1);
        for name in [
            "",
            ".",
            "..",
            ".hidden",
            "../victim",
            "../../etc/passwd",
            "a/b",
            "a\\b",
            "/abs",
            "C:evil",
            "name with space",
            "nul\0byte",
            "-flag",
            too_long.as_str(),
        ] {
            assert!(!valid_policy_name(name), "{:?} must be rejected", name);
        }
        for name in ["pii", "pii-v2", "my_policy", "org.block.v1", "A1"] {
            assert!(valid_policy_name(name), "{:?} must be accepted", name);
        }
        assert!(valid_policy_name(&"a".repeat(MAX_POLICY_NAME_LEN)));
    }

    #[test]
    fn policy_file_path_stays_inside_the_policy_directory() {
        let root = temp_dir("inside");
        let dir = root.join("policies");
        // The directory is created on first use.
        let path = policy_file_path(&dir, "pii").unwrap();
        assert!(dir.is_dir());
        assert_eq!(path, dir.canonicalize().unwrap().join("pii.wasm"));

        std::fs::write(root.join("victim.wasm"), b"x").unwrap();
        assert!(policy_file_path(&dir, "../victim").is_err());
        assert!(policy_file_path(&dir, "sub/victim").is_err());
        assert!(root.join("victim.wasm").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_policy_file_replaces_the_file_and_leaves_no_temporary() {
        let root = temp_dir("write");
        let dir = root.join("policies");
        let path = policy_file_path(&dir, "pii").unwrap();
        write_policy_file(&path, b"first").unwrap();
        write_policy_file(&path, b"second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        let names: Vec<String> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["pii.wasm".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn write_policy_file_refuses_symlinks_even_dangling_ones() {
        let root = temp_dir("write-symlink");
        let dir = root.join("policies");
        std::fs::create_dir_all(&dir).unwrap();
        // A dangling symlink resolves to nothing, so the path check lets it
        // through; the write must still not create the target.
        std::os::unix::fs::symlink(root.join("created.wasm"), dir.join("dangling.wasm")).unwrap();
        let path = policy_file_path(&dir, "dangling").unwrap();
        assert!(write_policy_file(&path, b"x").is_err());
        assert!(!root.join("created.wasm").exists());

        std::fs::write(root.join("outside.wasm"), b"keep").unwrap();
        std::os::unix::fs::symlink(root.join("outside.wasm"), dir.join("into.wasm")).unwrap();
        assert!(write_policy_file(&dir.join("into.wasm"), b"x").is_err());
        assert_eq!(std::fs::read(root.join("outside.wasm")).unwrap(), b"keep");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn policy_file_path_rejects_a_symlink_out_of_the_directory() {
        let root = temp_dir("symlink");
        let dir = root.join("policies");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(root.join("outside.wasm"), b"x").unwrap();
        std::os::unix::fs::symlink(root.join("outside.wasm"), dir.join("link.wasm")).unwrap();
        assert!(policy_file_path(&dir, "link").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_policy_file_deletes_the_listed_file() {
        let root = temp_dir("remove");
        let dir = root.join("policies");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pii.wasm"), b"x").unwrap();
        std::fs::write(dir.join("other.wasm"), b"y").unwrap();
        assert!(remove_policy_file(&dir, "pii").unwrap());
        assert!(!dir.join("pii.wasm").exists());
        assert!(dir.join("other.wasm").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_policy_file_reports_a_missing_file() {
        let root = temp_dir("remove-missing");
        let dir = root.join("policies");
        // No directory yet: nothing to delete.
        assert!(!remove_policy_file(&dir, "pii").unwrap());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pii.wasm.bak"), b"x").unwrap();
        assert!(!remove_policy_file(&dir, "pii").unwrap());
        assert!(dir.join("pii.wasm.bak").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_policy_file_rejects_names_with_path_separators() {
        let root = temp_dir("remove-names");
        let dir = root.join("policies");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(root.join("victim.wasm"), b"x").unwrap();
        std::fs::write(dir.join("sub").join("victim.wasm"), b"x").unwrap();
        for name in ["../victim", "sub/victim", "sub\\victim", "/victim", ".."] {
            assert!(remove_policy_file(&dir, name).is_err(), "{:?}", name);
        }
        assert!(root.join("victim.wasm").exists());
        assert!(dir.join("sub").join("victim.wasm").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_policy_file_refuses_a_directory() {
        let root = temp_dir("remove-dir");
        let dir = root.join("policies");
        std::fs::create_dir_all(dir.join("odd.wasm")).unwrap();
        assert!(remove_policy_file(&dir, "odd").is_err());
        assert!(dir.join("odd.wasm").is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn remove_policy_file_refuses_symlinks() {
        let root = temp_dir("remove-symlink");
        let dir = root.join("policies");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(root.join("outside.wasm"), b"keep").unwrap();
        std::os::unix::fs::symlink(root.join("outside.wasm"), dir.join("link.wasm")).unwrap();
        std::os::unix::fs::symlink(root.join("missing.wasm"), dir.join("dangling.wasm")).unwrap();
        assert!(remove_policy_file(&dir, "link").is_err());
        assert!(remove_policy_file(&dir, "dangling").is_err());
        assert!(std::fs::symlink_metadata(dir.join("link.wasm")).is_ok());
        assert!(std::fs::symlink_metadata(dir.join("dangling.wasm")).is_ok());
        assert_eq!(std::fs::read(root.join("outside.wasm")).unwrap(), b"keep");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ----- fail closed on unusable policies ---------------------------------

    /// A policy in WAT text form (wasmtime compiles it) that allows or denies
    /// every call.
    fn wat_policy(verdict: i32) -> Vec<u8> {
        format!(
            r#"(module
                (memory (export "memory") 1)
                (func (export "alloc") (param i32) (result i32) i32.const 16)
                (func (export "dealloc") (param i32 i32))
                (func (export "validate_tool_call") (param i32 i32 i32 i32) (result i32)
                    i32.const {verdict}))"#
        )
        .into_bytes()
    }

    fn fail_closed_engine(allowed_hashes: Vec<String>) -> ZnEngine {
        ZnEngine::new(ZnEngineConfig {
            gas_limit: 10_000_000,
            memory_limit: 10 * 1024 * 1024,
            // Generous: a tight epoch deadline can interrupt even a trivial policy on a loaded host.
            timeout_ms: 10_000,
            allowed_hashes,
            signing_public_key: None,
        })
        .expect("engine init")
    }

    #[test]
    fn an_empty_policy_directory_allows_calls() {
        let dir = temp_dir("fc-empty");
        let engine = fail_closed_engine(vec![]);
        engine.load_all_policies(&dir).unwrap();
        assert!(!engine.is_failing_closed());
        assert!(engine.policy_faults().is_empty());
        assert!(engine.check_tool_call_all("any", "{}", None).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_valid_policy_still_decides() {
        let dir = temp_dir("fc-valid");
        std::fs::write(dir.join("allow.wasm"), wat_policy(1)).unwrap();
        let engine = fail_closed_engine(vec![]);
        engine.load_all_policies(&dir).unwrap();
        assert_eq!(engine.policy_count(), 1);
        assert!(!engine.is_failing_closed());
        assert!(engine.check_tool_call_all("any", "{}", None).unwrap());

        std::fs::write(dir.join("deny.wasm"), wat_policy(0)).unwrap();
        engine.load_all_policies(&dir).unwrap();
        assert!(!engine.check_tool_call_all("any", "{}", None).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_policy_file_denies_calls_and_is_reported() {
        let dir = temp_dir("fc-corrupt");
        std::fs::write(dir.join("broken.wasm"), b"not wasm").unwrap();
        let engine = fail_closed_engine(vec![]);
        // Loading the directory still succeeds; the failure is recorded.
        engine.load_all_policies(&dir).unwrap();
        assert_eq!(engine.policy_count(), 0);
        assert!(engine.is_failing_closed());
        let faults = engine.policy_faults();
        assert_eq!(faults.len(), 1);
        assert_eq!(faults[0].0, "broken");
        assert!(faults[0].1.contains("failed to load"), "{:?}", faults);
        assert!(!engine.check_tool_call_all("any", "{}", None).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_policy_with_a_disallowed_hash_denies_calls() {
        let dir = temp_dir("fc-hash");
        std::fs::write(dir.join("good.wasm"), wat_policy(1)).unwrap();
        std::fs::write(dir.join("other.wasm"), wat_policy(0)).unwrap();
        let engine = fail_closed_engine(vec![ZnEngine::compute_hash(&wat_policy(1))]);
        engine.load_all_policies(&dir).unwrap();
        assert_eq!(engine.policy_count(), 1);
        assert!(engine.is_failing_closed());
        assert!(!engine.check_tool_call_all("any", "{}", None).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_policy_that_loads_later_clears_its_fault() {
        let dir = temp_dir("fc-recover");
        let path = dir.join("p.wasm");
        std::fs::write(&path, b"not wasm").unwrap();
        let engine = fail_closed_engine(vec![]);
        engine.load_all_policies(&dir).unwrap();
        assert!(engine.is_failing_closed());
        std::fs::write(&path, wat_policy(1)).unwrap();
        engine.register_policy_from_file(&path).unwrap();
        assert!(!engine.is_failing_closed());
        assert!(engine.check_tool_call_all("any", "{}", None).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_removed_registered_policy_denies_calls_but_a_deliberate_unregister_does_not() {
        let dir = temp_dir("fc-removed");
        std::fs::write(dir.join("p.wasm"), wat_policy(1)).unwrap();
        std::fs::write(dir.join("q.wasm"), wat_policy(1)).unwrap();
        let engine = fail_closed_engine(vec![]);
        engine.load_all_policies(&dir).unwrap();

        engine.policy_file_removed("p");
        assert!(engine.is_failing_closed());
        assert_eq!(
            engine.policy_faults(),
            vec![("p".to_string(), "policy file removed".to_string())]
        );
        assert!(!engine.check_tool_call_all("any", "{}", None).unwrap());

        // The management API's delete is deliberate and clears the fault.
        engine.unregister_policy("p");
        assert!(!engine.is_failing_closed());
        assert!(engine.check_tool_call_all("any", "{}", None).unwrap());

        // A file that never loaded disappearing is not a fault.
        engine.policy_file_removed("never-loaded");
        assert!(!engine.is_failing_closed());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
