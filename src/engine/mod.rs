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

/// WASM Policy Execution Engine
pub struct ZnEngine {
    engine: Engine,
    linker: Linker<ZnContext>,
    config: ZnEngineConfig,
    /// Registry of loaded policies (name -> Module)
    policies: DashMap<String, Arc<Module>>,
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

    /// Load and register a WASM policy from file with integrity verification
    pub fn register_policy_from_file(&self, path: impl AsRef<Path>) -> Result<()> {
        let path = path.as_ref();
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

    /// Unregister a policy by name
    pub fn unregister_policy(&self, name: &str) {
        if self.policies.remove(name).is_some() {
            info!("Unregistered policy: {}", name);
        }
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
        if self.policies.is_empty() {
            // No policies = allow (default behavior)
            return Ok(true);
        }

        for entry in self.policies.iter() {
            let policy_name = entry.key();
            let module = entry.value();
            if !self.check_tool_call(module, tool_name, arguments, agent_id.clone())? {
                warn!(
                    "Policy '{}' DENIED tool call: {}",
                    policy_name,
                    crate::scrubber::Scrubber::redact_for_log(tool_name)
                );
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
                    crate::scrubber::Scrubber::redact_for_log(tool_name),
                    consumed,
                    self.config.gas_limit
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

    // ---- WASM policy engine tests (policies are written as WAT text) ----

    const DEFAULT_ALLOC: &str = "(global $heap (mut i32) (i32.const 4096))
        (func (export \"alloc\") (param $n i32) (result i32)
          (local $p i32)
          (local.set $p (global.get $heap))
          (global.set $heap (i32.add (global.get $heap) (local.get $n)))
          (local.get $p))";

    fn policy_wat(alloc: &str, extra: &str, body: &str) -> String {
        format!(
            "(module
              (import \"env\" \"zn_get_agent_id\" (func $aid (param i32 i32) (result i32)))
              (import \"env\" \"zn_state_set\" (func $set (param i32 i32 i32 i32)))
              (import \"env\" \"zn_state_get\" (func $get (param i32 i32 i32 i32) (result i32)))
              (memory (export \"memory\") 1)
              (data (i32.const 2048) \"kv\")
              {extra}
              {alloc}
              (func (export \"dealloc\") (param i32 i32))
              (func (export \"validate_tool_call\") (param i32 i32 i32 i32) (result i32)
                {body}))"
        )
    }

    fn simple_policy(body: &str) -> String {
        policy_wat(DEFAULT_ALLOC, "", body)
    }

    fn engine_with(gas: u64, memory: u64, hashes: Vec<String>) -> ZnEngine {
        ZnEngine::new(ZnEngineConfig {
            gas_limit: gas,
            memory_limit: memory,
            timeout_ms: 5000,
            allowed_hashes: hashes,
            signing_public_key: None,
        })
        .unwrap()
    }

    fn engine() -> ZnEngine {
        engine_with(1_000_000, 16 * 1024 * 1024, Vec::new())
    }

    fn module_of(e: &ZnEngine, wat: &str) -> Module {
        e._load_policy_from_bytes(wat.as_bytes(), "test").unwrap()
    }

    #[test]
    fn policy_that_returns_one_allows_and_zero_denies() {
        let e = engine();
        let allow = module_of(&e, &simple_policy("(i32.const 1)"));
        let deny = module_of(&e, &simple_policy("(i32.const 0)"));
        assert!(e.check_tool_call(&allow, "tool", "{}", None).unwrap());
        assert!(!e.check_tool_call(&deny, "tool", "{}", None).unwrap());
    }

    #[test]
    fn policy_receives_the_tool_name_length() {
        let e = engine();
        let m = module_of(&e, &simple_policy("(i32.eq (local.get 1) (i32.const 4))"));
        assert!(e.check_tool_call(&m, "bash", "{}", None).unwrap());
        assert!(!e.check_tool_call(&m, "other", "{}", None).unwrap());
    }

    #[test]
    fn agent_id_host_function_returns_the_identity_length() {
        let e = engine();
        let m = module_of(
            &e,
            &simple_policy("(i32.eq (call $aid (i32.const 1024) (i32.const 16)) (i32.const 5))"),
        );
        assert!(e
            .check_tool_call(&m, "t", "{}", Some("agent".to_string()))
            .unwrap());
        assert!(!e.check_tool_call(&m, "t", "{}", None).unwrap());
        assert!(!e
            .check_tool_call(&m, "t", "{}", Some("longer-agent".to_string()))
            .unwrap());
    }

    #[test]
    fn state_store_is_shared_between_policy_calls() {
        let e = engine();
        let setter = module_of(
            &e,
            &simple_policy(
                "(call $set (i32.const 2048) (i32.const 1) (i32.const 2049) (i32.const 1))
                 (i32.const 1)",
            ),
        );
        let getter = module_of(
            &e,
            &simple_policy(
                "(i32.eq (call $get (i32.const 2048) (i32.const 1) (i32.const 3000) (i32.const 8))
                         (i32.const 1))",
            ),
        );
        assert!(!e.check_tool_call(&getter, "t", "{}", None).unwrap());
        assert!(e.check_tool_call(&setter, "t", "{}", None).unwrap());
        assert!(e.check_tool_call(&getter, "t", "{}", None).unwrap());
    }

    #[test]
    fn state_host_functions_ignore_out_of_bounds_pointers() {
        let e = engine();
        let m = module_of(
            &e,
            &simple_policy(
                "(call $set (i32.const 70000) (i32.const 1) (i32.const 70000) (i32.const 1))
                 (i32.eq (call $get (i32.const 70000) (i32.const 1) (i32.const 0) (i32.const 1))
                         (i32.const 0))",
            ),
        );
        assert!(e.check_tool_call(&m, "t", "{}", None).unwrap());
    }

    #[test]
    fn state_get_truncates_the_copy_to_the_buffer_size() {
        let e = engine();
        let m = module_of(
            &e,
            &simple_policy(
                "(call $set (i32.const 2048) (i32.const 1) (i32.const 2048) (i32.const 2))
                 (i32.eq (call $get (i32.const 2048) (i32.const 1) (i32.const 3000) (i32.const 1))
                         (i32.const 2))",
            ),
        );
        assert!(e.check_tool_call(&m, "t", "{}", None).unwrap());
    }

    #[test]
    fn memory_growth_beyond_the_limit_is_refused() {
        let wat = simple_policy("(i32.eq (memory.grow (i32.const 10)) (i32.const -1))");
        let small = engine_with(1_000_000, 65536, Vec::new());
        let m = module_of(&small, &wat);
        assert!(small.check_tool_call(&m, "t", "{}", None).unwrap());
        let large = engine();
        let m = module_of(&large, &wat);
        assert!(!large.check_tool_call(&m, "t", "{}", None).unwrap());
    }

    #[test]
    fn module_needing_more_memory_than_the_limit_fails_to_run() {
        let e = engine_with(1_000_000, 1000, Vec::new());
        let m = module_of(&e, &simple_policy("(i32.const 1)"));
        assert!(e.check_tool_call(&m, "t", "{}", None).is_err());
    }

    #[test]
    fn table_growth_beyond_the_limit_is_refused() {
        let e = engine();
        let wat = policy_wat(
            DEFAULT_ALLOC,
            "(table $t 1 funcref)",
            "(i32.eq (table.grow $t (ref.null func) (i32.const 2000)) (i32.const -1))",
        );
        let m = module_of(&e, &wat);
        assert!(e.check_tool_call(&m, "t", "{}", None).unwrap());
        let wat = policy_wat(
            DEFAULT_ALLOC,
            "(table $t 1 funcref)",
            "(i32.eq (table.grow $t (ref.null func) (i32.const 10)) (i32.const -1))",
        );
        let m = module_of(&e, &wat);
        assert!(!e.check_tool_call(&m, "t", "{}", None).unwrap());
    }

    #[test]
    fn policy_that_runs_out_of_gas_is_an_error() {
        let e = engine_with(10_000, 16 * 1024 * 1024, Vec::new());
        let m = module_of(&e, &simple_policy("(loop $l (br $l)) (i32.const 1)"));
        assert!(e.check_tool_call(&m, "t", "{}", None).is_err());
    }

    #[test]
    fn policy_using_most_of_the_gas_still_returns_its_verdict() {
        let e = engine_with(20_000, 16 * 1024 * 1024, Vec::new());
        let m = module_of(
            &e,
            &simple_policy(
                "(local $i i32)
                 (loop $l
                   (local.set $i (i32.add (local.get $i) (i32.const 1)))
                   (br_if $l (i32.lt_u (local.get $i) (i32.const 2000))))
                 (i32.const 1)",
            ),
        );
        assert!(e.check_tool_call(&m, "t", "{}", None).unwrap());
    }

    #[test]
    fn policy_without_memory_export_is_an_error() {
        let e = engine();
        let wat = "(module
          (memory 1)
          (func (export \"alloc\") (param i32) (result i32) (i32.const 8))
          (func (export \"dealloc\") (param i32 i32))
          (func (export \"validate_tool_call\") (param i32 i32 i32 i32) (result i32) (i32.const 1)))";
        let m = module_of(&e, wat);
        let err = e.check_tool_call(&m, "t", "{}", None).unwrap_err();
        assert!(err.to_string().contains("memory export"));
    }

    #[test]
    fn policy_missing_an_export_is_an_error() {
        let e = engine();
        let wat = "(module
          (memory (export \"memory\") 1)
          (func (export \"alloc\") (param i32) (result i32) (i32.const 8)))";
        let m = module_of(&e, wat);
        assert!(e.check_tool_call(&m, "t", "{}", None).is_err());
    }

    #[test]
    fn allocation_failure_for_the_tool_name_is_an_error() {
        let e = engine();
        let alloc = "(func (export \"alloc\") (param i32) (result i32) (i32.const 0))";
        let m = module_of(&e, &policy_wat(alloc, "", "(i32.const 1)"));
        let err = e.check_tool_call(&m, "t", "{}", None).unwrap_err();
        assert!(err.to_string().contains("tool name"));
    }

    #[test]
    fn allocation_failure_for_the_arguments_is_an_error() {
        let e = engine();
        let alloc = "(global $n (mut i32) (i32.const 0))
            (func (export \"alloc\") (param i32) (result i32)
              (global.set $n (i32.add (global.get $n) (i32.const 1)))
              (if (result i32) (i32.eq (global.get $n) (i32.const 2))
                (then (i32.const 0))
                (else (i32.const 512))))";
        let m = module_of(&e, &policy_wat(alloc, "", "(i32.const 1)"));
        let err = e.check_tool_call(&m, "t", "{}", None).unwrap_err();
        assert!(err.to_string().contains("arguments"));
    }

    #[test]
    fn allocation_outside_memory_makes_the_write_fail() {
        let e = engine();
        let alloc = "(func (export \"alloc\") (param i32) (result i32) (i32.const 70000))";
        let m = module_of(&e, &policy_wat(alloc, "", "(i32.const 1)"));
        assert!(e.check_tool_call(&m, "t", "{}", None).is_err());
    }

    #[test]
    fn check_tool_call_all_allows_without_policies_and_requires_every_policy() {
        let e = engine();
        assert!(e.check_tool_call_all("t", "{}", None).unwrap());

        let dir = temp_dir("check-all");
        std::fs::write(dir.join("allow.wasm"), simple_policy("(i32.const 1)")).unwrap();
        e.load_all_policies(&dir).unwrap();
        assert!(e.check_tool_call_all("t", "{}", None).unwrap());

        std::fs::write(dir.join("deny.wasm"), simple_policy("(i32.const 0)")).unwrap();
        e.load_all_policies(&dir).unwrap();
        assert_eq!(e.policy_count(), 2);
        assert!(!e.check_tool_call_all("t", "{}", None).unwrap());

        e.unregister_policy("deny");
        assert!(e.check_tool_call_all("t", "{}", None).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn check_tool_call_all_propagates_policy_errors() {
        let e = engine_with(10_000, 16 * 1024 * 1024, Vec::new());
        let dir = temp_dir("check-all-err");
        std::fs::write(
            dir.join("loop.wasm"),
            simple_policy("(loop $l (br $l)) (i32.const 1)"),
        )
        .unwrap();
        e.load_all_policies(&dir).unwrap();
        assert!(e.check_tool_call_all("t", "{}", None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn register_policy_from_file_registers_by_file_stem() {
        let e = engine();
        let dir = temp_dir("register");
        let path = dir.join("my-policy.wasm");
        std::fs::write(&path, simple_policy("(i32.const 1)")).unwrap();
        e.register_policy_from_file(&path).unwrap();
        assert!(e._has_policy("my-policy"));
        assert!(e._get_policy("my-policy").is_some());
        assert!(e._get_policy("other").is_none());
        assert_eq!(e.list_policies(), vec!["my-policy".to_string()]);
        e.unregister_policy("my-policy");
        e.unregister_policy("my-policy");
        assert_eq!(e.policy_count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn register_policy_from_file_reports_missing_and_invalid_files() {
        let e = engine();
        let dir = temp_dir("register-bad");
        let err = e
            .register_policy_from_file(dir.join("missing.wasm"))
            .unwrap_err();
        assert!(err.to_string().contains("Failed to read policy file"));

        let bad = dir.join("bad.wasm");
        std::fs::write(&bad, b"not a wasm module").unwrap();
        let err = e.register_policy_from_file(&bad).unwrap_err();
        assert!(err.to_string().contains("Failed to compile WASM policy"));
        assert_eq!(e.policy_count(), 0);

        let err = e.register_policy_from_file(Path::new("/")).unwrap_err();
        assert!(err.to_string().contains("Invalid policy filename"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn integrity_check_accepts_only_listed_hashes() {
        let wat = simple_policy("(i32.const 1)");
        let good = ZnEngine::compute_hash(wat.as_bytes());
        let dir = temp_dir("integrity");
        let path = dir.join("p.wasm");
        std::fs::write(&path, &wat).unwrap();

        let allowed = engine_with(1_000_000, 16 * 1024 * 1024, vec![good]);
        allowed.register_policy_from_file(&path).unwrap();
        assert!(allowed._has_policy("p"));
        assert!(allowed._load_policy_from_bytes(wat.as_bytes(), "p").is_ok());

        let strict = engine_with(1_000_000, 16 * 1024 * 1024, vec!["00".repeat(32)]);
        let err = strict.register_policy_from_file(&path).unwrap_err();
        assert!(err.to_string().contains("integrity check failed"));
        assert!(!strict._has_policy("p"));
        let err = strict
            ._load_policy_from_bytes(wat.as_bytes(), "p")
            .unwrap_err();
        assert!(err.to_string().contains("integrity check failed"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_all_policies_creates_a_missing_directory() {
        let e = engine();
        let root = temp_dir("load-missing");
        let dir = root.join("policies");
        e.load_all_policies(&dir).unwrap();
        assert!(dir.is_dir());
        assert_eq!(e.policy_count(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn load_all_policies_skips_bad_blocked_and_non_wasm_files() {
        let wat = simple_policy("(i32.const 1)");
        let good = ZnEngine::compute_hash(wat.as_bytes());
        let e = engine_with(1_000_000, 16 * 1024 * 1024, vec![good]);
        let dir = temp_dir("load-mixed");
        std::fs::write(dir.join("good.wasm"), &wat).unwrap();
        std::fs::write(dir.join("blocked.wasm"), simple_policy("(i32.const 0)")).unwrap();
        std::fs::write(dir.join("notes.txt"), b"ignored").unwrap();
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(
            dir.join("nested").join("deep.wasm"),
            simple_policy("(i32.const 1)"),
        )
        .unwrap();
        e.load_all_policies(&dir).unwrap();
        assert_eq!(e.list_policies(), vec!["good".to_string()]);

        let open = engine();
        std::fs::write(dir.join("broken.wasm"), b"garbage").unwrap();
        open.load_all_policies(&dir).unwrap();
        assert!(open._has_policy("good"));
        assert!(open._has_policy("blocked"));
        assert!(!open._has_policy("broken"));
        assert!(!open._has_policy("deep"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_policy_writes_and_registers_a_valid_policy() {
        let e = engine();
        let dir = temp_dir("install");
        let path = dir.join("fresh.wasm");
        let wat = simple_policy("(i32.const 1)");
        e.install_policy(&path, wat.as_bytes()).unwrap();
        assert!(path.is_file());
        assert!(e._has_policy("fresh"));
        assert!(e.check_tool_call_all("t", "{}", None).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_policy_writes_nothing_when_a_check_fails() {
        let dir = temp_dir("install-fail");
        let wat = simple_policy("(i32.const 1)");

        let strict = engine_with(1_000_000, 16 * 1024 * 1024, vec!["00".repeat(32)]);
        let path = dir.join("blocked.wasm");
        assert!(strict.install_policy(&path, wat.as_bytes()).is_err());
        assert!(!path.exists());

        let e = engine();
        let path = dir.join("broken.wasm");
        assert!(e.install_policy(&path, b"garbage").is_err());
        assert!(!path.exists());
        assert_eq!(e.policy_count(), 0);

        let err = e
            .install_policy(Path::new("/"), wat.as_bytes())
            .unwrap_err();
        assert!(err.to_string().contains("Invalid policy filename"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn engine_rejects_an_invalid_signing_key() {
        let config = |key: &str| ZnEngineConfig {
            gas_limit: 1000,
            memory_limit: 65536,
            timeout_ms: 1000,
            allowed_hashes: Vec::new(),
            signing_public_key: Some(key.to_string()),
        };
        assert!(ZnEngine::new(config("not-hex")).is_err());
        assert!(ZnEngine::new(config("abcd")).is_err());
    }

    #[test]
    fn signed_engine_refuses_a_policy_without_a_signature_file() {
        let e = ZnEngine::new(ZnEngineConfig {
            gas_limit: 1_000_000,
            memory_limit: 16 * 1024 * 1024,
            timeout_ms: 5000,
            allowed_hashes: Vec::new(),
            signing_public_key: Some(
                "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c".to_string(),
            ),
        })
        .unwrap();
        let dir = temp_dir("unsigned");
        let path = dir.join("p.wasm");
        let wat = simple_policy("(i32.const 1)");
        std::fs::write(&path, &wat).unwrap();
        let err = e.register_policy_from_file(&path).unwrap_err();
        assert!(err.to_string().contains("signature"));
        assert!(e.install_policy(&path, wat.as_bytes()).is_err());
        assert_eq!(e.policy_count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
