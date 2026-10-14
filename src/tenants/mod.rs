//! Tenant Management Module
//!
//! Provides multi-tenancy support for zn with:
//! - Per-tenant API keys
//! - Role-based access control
//! - Isolated audit logs via namespaces

use anyhow::{anyhow, Result};
use chrono::Utc;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// Tenant roles for access control
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TenantRole {
    SuperAdmin, // Full platform access
    Admin,      // Tenant management access
    User,       // Normal tenant access
    Viewer,     // Read-only tenant access
    Blocked,    // Access denied
}

impl TenantRole {
    pub fn parse(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "superadmin" => TenantRole::SuperAdmin,
            "admin" => TenantRole::Admin,
            "user" => TenantRole::User,
            "viewer" => TenantRole::Viewer,
            "blocked" => TenantRole::Blocked,
            _ => TenantRole::User,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            TenantRole::SuperAdmin => "superadmin",
            TenantRole::Admin => "admin",
            TenantRole::User => "user",
            TenantRole::Viewer => "viewer",
            TenantRole::Blocked => "blocked",
        }
    }
}

/// Namespace of the super-admin context and of the seeded default
/// organisation. Reserved: tenants and tenant tokens cannot use it.
pub const GLOBAL_NAMESPACE: &str = "global";

/// A tenant namespace is used as is: non-empty, at most 128 bytes, no
/// whitespace or control characters, and not the reserved global namespace
/// (in any letter case).
pub fn valid_tenant_namespace(ns: &str) -> bool {
    !ns.is_empty()
        && ns.len() <= 128
        && !ns.chars().any(|c| c.is_whitespace() || c.is_control())
        && !ns.eq_ignore_ascii_case(GLOBAL_NAMESPACE)
}

/// Key for the seeded default organisation.
enum SeedKey {
    /// From `ZN_API_KEY`; never printed or stored.
    FromEnv(String),
    /// Generated at random; written once to the seed key file, never printed.
    Generated(String),
}

/// File that receives a generated SuperAdmin key: `zn-superadmin-key.txt`
/// next to the database at `db_path`.
pub fn seed_key_file_for(db_path: impl AsRef<Path>) -> PathBuf {
    db_path.as_ref().with_file_name("zn-superadmin-key.txt")
}

/// Writes `key` to a new file at `path` that only the current user can read
/// and write (mode 0600 on Unix; on Windows the file inherits the ACL of its
/// directory). A file or symlink already at `path` is removed first, never
/// followed.
fn write_seed_key_file(path: &Path, key: &str) -> Result<()> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)
            .map_err(|e| anyhow!("Failed to create directory {:?}: {}", dir, e))?;
    }
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(anyhow!("Failed to replace {:?}: {}", path, e)),
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(path)
        .map_err(|e| anyhow!("Failed to create {:?}: {}", path, e))?;
    writeln!(file, "{}", key)
        .and_then(|_| file.sync_all())
        .map_err(|e| anyhow!("Failed to write {:?}: {}", path, e))?;
    Ok(())
}

/// `ZN_API_KEY` (trimmed) when it is set and not blank, otherwise a new
/// random key. A blank value counts as not set, so the default organisation
/// is never seeded with the hash of an empty key.
fn seed_key(env_key: Option<String>) -> SeedKey {
    match crate::config::normalize_credential(env_key) {
        Some(k) => SeedKey::FromEnv(k),
        None => {
            use rand::distr::{Alphanumeric, SampleString};
            SeedKey::Generated(Alphanumeric.sample_string(&mut rand::rng(), 32))
        }
    }
}

/// Blank keys an older release may have stored for a tenant, for example by
/// seeding the default organisation from `ZN_API_KEY=""`. They are refused
/// now, so such a tenant can no longer authenticate.
const BLANK_KEYS: [&str; 7] = ["", " ", "  ", "   ", "\t", "\n", "\r\n"];

/// Represents a tenant (organization/user) in the system
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tenant {
    pub id: String,
    pub name: String,
    pub namespace: String,
    pub api_key: String,
    pub role: TenantRole,
    pub created_at: String,
}

/// Context injected into requests after authentication
#[derive(Debug, Clone)]
pub struct TenantContext {
    pub id: String,
    pub name: String,
    pub namespace: String,
    pub role: TenantRole,
}

impl TenantContext {
    pub fn is_super_admin(&self) -> bool {
        self.role == TenantRole::SuperAdmin
    }

    pub fn is_admin(&self) -> bool {
        self.role == TenantRole::Admin || self.role == TenantRole::SuperAdmin
    }
}

/// Persistent storage for tenant data
pub struct TenantStore {
    conn: Arc<Mutex<Connection>>,
}

impl TenantStore {
    /// Create a new TenantStore, initializing the schema if needed.
    ///
    /// When no tenant exists, a SuperAdmin tenant is seeded with
    /// `ZN_API_KEY`, or with a random key that is not saved anywhere; use
    /// [`TenantStore::open`] to keep a generated key.
    pub fn new(conn: Arc<Mutex<Connection>>) -> Result<Self> {
        Self::open(conn, None)
    }

    /// Like [`TenantStore::new`], but a generated SuperAdmin key is written
    /// to `seed_key_file` (readable only by the current user) before the
    /// tenant is seeded. The key is never printed. If the file cannot be
    /// written, nothing is seeded and an error is returned.
    pub fn open(conn: Arc<Mutex<Connection>>, seed_key_file: Option<&Path>) -> Result<Self> {
        Self::init(conn, std::env::var("ZN_API_KEY").ok(), seed_key_file)
    }

    fn init(
        conn: Arc<Mutex<Connection>>,
        env_key: Option<String>,
        seed_key_file: Option<&Path>,
    ) -> Result<Self> {
        {
            let db = conn.lock().map_err(|e| anyhow!("Lock poisoned: {}", e))?;

            db.execute(
                "CREATE TABLE IF NOT EXISTS tenants (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    namespace TEXT NOT NULL UNIQUE,
                    api_key_hash TEXT NOT NULL UNIQUE,
                    role TEXT NOT NULL DEFAULT 'viewer',
                    created_at TEXT NOT NULL
                )",
                [],
            )
            .map_err(|e| anyhow!("Failed to create tenants table: {}", e))?;

            // Seed a default 'global' tenant if none exist for easy startup
            let count: i64 = db.query_row("SELECT COUNT(*) FROM tenants", [], |r| r.get(0))?;
            if count == 0 {
                let id = Uuid::new_v4().to_string();

                // ZN_API_KEY when set and not blank, otherwise a random key.
                let seed = seed_key(env_key);
                let (api_key, source) = match &seed {
                    SeedKey::FromEnv(k) => (k.as_str(), "Environment Variable (ZN_API_KEY)"),
                    SeedKey::Generated(k) => (k.as_str(), "Generated Random Key"),
                };

                let hash = Self::hash_api_key(api_key);
                let created_at = Utc::now().to_rfc3339();

                // A generated key goes to a file only the current user can
                // read, never to stdout or the logs, which often end up in
                // container or CI logs. It is written before the tenant is
                // seeded, so a failed write leaves nothing half done.
                let written_to = match (&seed, seed_key_file) {
                    (SeedKey::Generated(key), Some(path)) => {
                        write_seed_key_file(path, key)?;
                        Some(path)
                    }
                    _ => None,
                };

                db.execute(
                    "INSERT INTO tenants (id, name, namespace, api_key_hash, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![id, "Default Org", GLOBAL_NAMESPACE, hash, "superadmin", created_at],
                )?;

                println!("\n\x1b[32;1m🛡️ zn Initialized Successfully!\x1b[0m");
                println!("\x1b[33mNo superadmin tenant found. A new one has been seeded.\x1b[0m");
                println!("Source: {}", source);
                match (&seed, written_to) {
                    (SeedKey::Generated(_), Some(path)) => println!(
                        "\x1b[32;1mSuperAdmin API key written to {}\x1b[0m (only your user can read it).\n\x1b[31;1mIMPORTANT: copy it somewhere safe, then delete the file.\x1b[0m\n",
                        path.display()
                    ),
                    (SeedKey::Generated(_), None) => println!(
                        "\x1b[33mThe generated SuperAdmin key was not saved. Set ZN_API_KEY to choose the key.\x1b[0m\n"
                    ),
                    (SeedKey::FromEnv(_), _) => {}
                }

                tracing::info!("Seeded default SuperAdmin tenant from {}", source);
            }

            match Self::tenants_with_blank_keys(&db) {
                Ok(tenants) => {
                    for (id, name, namespace) in tenants {
                        tracing::warn!(
                            "Tenant '{}' (namespace '{}', id {}) has a blank API key, stored by an \
                             older release. Blank keys are refused, so it cannot authenticate. \
                             Give it a new key: UPDATE tenants SET api_key_hash = '<SHA-256 hex \
                             of the new key>' WHERE id = '{}'; (see docs/rust-core.md)",
                            name,
                            namespace,
                            id,
                            id
                        );
                    }
                }
                Err(e) => tracing::warn!("Could not check tenants for blank API keys: {}", e),
            }

            tracing::info!("TenantStore initialized");
        }

        Ok(Self { conn })
    }

    /// (id, name, namespace) of the tenants whose stored key is blank.
    fn tenants_with_blank_keys(db: &Connection) -> Result<Vec<(String, String, String)>> {
        let mut stmt =
            db.prepare("SELECT id, name, namespace FROM tenants WHERE api_key_hash = ?1")?;
        let mut found = Vec::new();
        for key in BLANK_KEYS {
            let rows = stmt.query_map(params![Self::hash_api_key(key)], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?;
            for row in rows {
                found.push(row?);
            }
        }
        Ok(found)
    }

    /// Create a new tenant (used by main.rs)
    pub fn create_tenant(&self, name: &str, namespace: &str, api_key: &str) -> Result<()> {
        if !valid_tenant_namespace(namespace) {
            return Err(anyhow!(
                "Invalid namespace: it must be 1-128 bytes without whitespace or control characters, and \"{}\" is reserved",
                GLOBAL_NAMESPACE
            ));
        }
        if api_key.trim().is_empty() {
            return Err(anyhow!("API key must not be empty"));
        }
        let db = self
            .conn
            .lock()
            .map_err(|e| anyhow!("Lock poisoned: {}", e))?;

        let id = Uuid::new_v4().to_string();
        let api_key_hash = Self::hash_api_key(api_key);
        let created_at = Utc::now().to_rfc3339();

        db.execute(
            "INSERT INTO tenants (id, name, namespace, api_key_hash, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, name, namespace, api_key_hash, "user", created_at],
        ).map_err(|e| anyhow!("Failed to create tenant: {}", e))?;

        Ok(())
    }

    /// List all tenants (used by main.rs)
    pub fn list_tenants(&self) -> Result<Vec<Tenant>> {
        let db = self
            .conn
            .lock()
            .map_err(|e| anyhow!("Lock poisoned: {}", e))?;

        let mut stmt = db.prepare(
            "SELECT id, name, namespace, role, created_at FROM tenants ORDER BY created_at DESC",
        )?;

        let tenants = stmt.query_map([], |row: &Row| {
            let role_str: String = row.get(3)?;
            Ok(Tenant {
                id: row.get(0)?,
                name: row.get(1)?,
                namespace: row.get(2)?,
                api_key: "[REDACTED]".to_string(),
                role: TenantRole::parse(&role_str),
                created_at: row.get(4)?,
            })
        })?;

        let mut result = Vec::new();
        for tenant in tenants {
            result.push(tenant?);
        }
        Ok(result)
    }

    /// Look up a tenant by API key (for authentication)
    pub fn find_by_api_key(&self, api_key: &str) -> Result<Option<TenantContext>> {
        // An empty or blank key never matches a tenant.
        if api_key.trim().is_empty() {
            return Ok(None);
        }
        let db = self
            .conn
            .lock()
            .map_err(|e| anyhow!("Lock poisoned: {}", e))?;
        let api_key_hash = Self::hash_api_key(api_key);

        let mut stmt =
            db.prepare("SELECT id, name, namespace, role FROM tenants WHERE api_key_hash = ?1")?;

        let result = stmt.query_row([api_key_hash], |row: &Row| {
            let role_str: String = row.get(3)?;
            Ok(TenantContext {
                id: row.get(0)?,
                name: row.get(1)?,
                namespace: row.get(2)?,
                role: TenantRole::parse(&role_str),
            })
        });

        match result {
            Ok(ctx) => Ok(Some(ctx)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(anyhow!("Database error: {}", e)),
        }
    }

    /// Simple SHA-256 hash for API key storage
    fn hash_api_key(key: &str) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(key.as_bytes());
        hex::encode(hasher.finalize())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn setup_test_store() -> TenantStore {
        // Use in-memory database for tests
        let conn = Connection::open_in_memory().expect("Failed to open in-memory DB");
        let conn = Arc::new(Mutex::new(conn));
        // Set env var to avoid random key generation logs
        std::env::set_var("ZN_API_KEY", "test_super_admin_key");
        TenantStore::new(conn).expect("Failed to create TenantStore")
    }

    #[test]
    fn test_role_from_str() {
        assert_eq!(TenantRole::parse("superadmin"), TenantRole::SuperAdmin);
        assert_eq!(TenantRole::parse("SUPERADMIN"), TenantRole::SuperAdmin);
        assert_eq!(TenantRole::parse("admin"), TenantRole::Admin);
        assert_eq!(TenantRole::parse("user"), TenantRole::User);
        assert_eq!(TenantRole::parse("viewer"), TenantRole::Viewer);
        assert_eq!(TenantRole::parse("blocked"), TenantRole::Blocked);
        assert_eq!(TenantRole::parse("unknown"), TenantRole::User); // Default
    }

    #[test]
    fn test_role_as_str() {
        assert_eq!(TenantRole::SuperAdmin.as_str(), "superadmin");
        assert_eq!(TenantRole::Admin.as_str(), "admin");
        assert_eq!(TenantRole::User.as_str(), "user");
        assert_eq!(TenantRole::Viewer.as_str(), "viewer");
        assert_eq!(TenantRole::Blocked.as_str(), "blocked");
    }

    #[test]
    fn test_tenant_context_permissions() {
        let super_admin = TenantContext {
            id: "1".to_string(),
            name: "Super".to_string(),
            namespace: "global".to_string(),
            role: TenantRole::SuperAdmin,
        };

        let admin = TenantContext {
            id: "2".to_string(),
            name: "Admin".to_string(),
            namespace: "org_a".to_string(),
            role: TenantRole::Admin,
        };

        let user = TenantContext {
            id: "3".to_string(),
            name: "User".to_string(),
            namespace: "org_a".to_string(),
            role: TenantRole::User,
        };

        assert!(super_admin.is_super_admin());
        assert!(super_admin.is_admin());

        assert!(!admin.is_super_admin());
        assert!(admin.is_admin());

        assert!(!user.is_super_admin());
        assert!(!user.is_admin());
    }

    #[test]
    fn test_create_and_list_tenant() {
        let store = setup_test_store();

        // Create a new tenant
        store
            .create_tenant("Acme Corp", "acme", "acme_api_key_123")
            .unwrap();

        // List tenants (should include default + acme)
        let tenants = store.list_tenants().unwrap();
        assert!(tenants.len() >= 2);

        let acme = tenants.iter().find(|t| t.name == "Acme Corp");
        assert!(acme.is_some());
        assert_eq!(acme.unwrap().namespace, "acme");
        assert_eq!(acme.unwrap().api_key, "[REDACTED]"); // API key should be redacted
    }

    #[test]
    fn test_find_by_api_key() {
        let store = setup_test_store();

        // Find super admin by env key
        let found = store.find_by_api_key("test_super_admin_key").unwrap();
        assert!(found.is_some());
        let ctx = found.unwrap();
        assert_eq!(ctx.role, TenantRole::SuperAdmin);
        assert_eq!(ctx.namespace, "global");

        // Create and find a new tenant
        store
            .create_tenant("Test Org", "test_ns", "test_key_abc")
            .unwrap();
        let found = store.find_by_api_key("test_key_abc").unwrap();
        assert!(found.is_some());
        let ctx = found.unwrap();
        assert_eq!(ctx.namespace, "test_ns");
        assert_eq!(ctx.role, TenantRole::User);

        // Invalid key should return None
        let not_found = store.find_by_api_key("wrong_key").unwrap();
        assert!(not_found.is_none());
    }

    #[test]
    fn test_api_key_hashing() {
        let hash1 = TenantStore::hash_api_key("my_secret_key");
        let hash2 = TenantStore::hash_api_key("my_secret_key");
        let hash3 = TenantStore::hash_api_key("different_key");

        assert_eq!(hash1, hash2); // Same key = same hash
        assert_ne!(hash1, hash3); // Different key = different hash
        assert_eq!(hash1.len(), 64); // SHA-256 = 64 hex chars
    }

    #[test]
    fn create_tenant_checks_namespace_and_key() {
        let store = setup_test_store();
        for ns in ["", "global", "GLOBAL", " acme", "ac me", "acme\n"] {
            assert!(
                store.create_tenant("n", ns, "key_for_ns_test").is_err(),
                "{ns:?}"
            );
        }
        assert!(store
            .create_tenant("long", &"a".repeat(129), "key_129")
            .is_err());
        store
            .create_tenant("max", &"a".repeat(128), "key_128")
            .unwrap();
        assert!(store.create_tenant("nokey", "nokey", "").is_err());
        assert!(store.create_tenant("blank", "blank", "   ").is_err());
    }

    #[test]
    fn blank_seed_key_is_replaced_by_a_generated_one() {
        for env in [None, Some(""), Some("   ")] {
            match seed_key(env.map(String::from)) {
                SeedKey::Generated(k) => assert_eq!(k.len(), 32),
                SeedKey::FromEnv(_) => panic!("{env:?} must not be used as a key"),
            }
        }
        assert!(matches!(
            seed_key(Some("operator-key".to_string())),
            SeedKey::FromEnv(k) if k == "operator-key"
        ));
        // Surrounding whitespace is not part of the key.
        assert!(matches!(
            seed_key(Some("  operator-key\n".to_string())),
            SeedKey::FromEnv(k) if k == "operator-key"
        ));
    }

    #[test]
    fn tenants_with_blank_keys_are_found_and_never_match() {
        let store = setup_test_store();
        let db = store.conn.lock().unwrap();
        assert!(TenantStore::tenants_with_blank_keys(&db)
            .unwrap()
            .is_empty());
        // As an older release could have stored them.
        for (id, key) in [("t-empty", ""), ("t-spaces", "   ")] {
            db.execute(
                "INSERT INTO tenants (id, name, namespace, api_key_hash, role, created_at) VALUES (?1, ?1, ?1, ?2, 'superadmin', 'now')",
                params![id, TenantStore::hash_api_key(key)],
            )
            .unwrap();
        }
        let mut ids: Vec<String> = TenantStore::tenants_with_blank_keys(&db)
            .unwrap()
            .into_iter()
            .map(|(id, _, _)| id)
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["t-empty", "t-spaces"]);
        drop(db);
        for key in ["", "   ", "\t"] {
            assert!(store.find_by_api_key(key).unwrap().is_none(), "{key:?}");
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zn-tenants-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn memory_conn() -> Arc<Mutex<Connection>> {
        Arc::new(Mutex::new(Connection::open_in_memory().unwrap()))
    }

    #[test]
    fn generated_seed_key_is_written_to_a_private_file() {
        let dir = temp_dir("seed");
        let file = seed_key_file_for(dir.join("zn.db"));
        assert_eq!(file, dir.join("zn-superadmin-key.txt"));
        // A stale file from an earlier seed is replaced.
        std::fs::write(&file, "stale").unwrap();

        let store = TenantStore::init(memory_conn(), None, Some(&file)).unwrap();
        let key = std::fs::read_to_string(&file).unwrap();
        let key = key.trim_end();
        assert_eq!(key.len(), 32);
        let ctx = store
            .find_by_api_key(key)
            .unwrap()
            .expect("key authenticates");
        assert_eq!(ctx.role, TenantRole::SuperAdmin);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "key file must not be readable by others");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn env_seed_key_is_not_written_to_a_file() {
        let dir = temp_dir("env");
        let file = dir.join("zn-superadmin-key.txt");
        let store =
            TenantStore::init(memory_conn(), Some("operator-key".into()), Some(&file)).unwrap();
        assert!(!file.exists());
        assert!(store.find_by_api_key("operator-key").unwrap().is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_key_file_write_seeds_nothing() {
        let dir = temp_dir("fail");
        // The parent of the key file is a regular file, so it cannot be created.
        std::fs::write(dir.join("not-a-dir"), "x").unwrap();
        let file = dir.join("not-a-dir").join("zn-superadmin-key.txt");
        let conn = memory_conn();
        assert!(TenantStore::init(Arc::clone(&conn), None, Some(&file)).is_err());
        let count: i64 = conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM tenants", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_api_key_finds_no_tenant() {
        let store = setup_test_store();
        assert!(store.find_by_api_key("").unwrap().is_none());
    }
}
