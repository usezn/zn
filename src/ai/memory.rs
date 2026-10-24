//! Per-agent vector memory stored in SQLite.
//!
//! Each (model, dimension) pair gets its own database file under `base_path`.
//! Rows belong to a namespace and, inside it, to an agent. Search is an exact
//! scan that returns the squared Euclidean (L2) distance, so existing anomaly
//! thresholds keep their meaning.
//!
//! # Isolation
//!
//! The agent id comes from the MCP message and is not authenticated, so it
//! cannot be the isolation boundary. The caller passes the namespace of the
//! authenticated tenant (or of the local process), and every read and write is
//! scoped to that namespace: an agent only ever sees rows of its own
//! namespace. Only the file limit (see below) can delete rows of another
//! namespace, and only of one above its fair share of the file.
//!
//! # Size limits
//!
//! Size is bounded three times:
//! - each agent keeps at most `max_rows` rows (its most recent ones);
//! - each namespace keeps at most `max_namespace_rows` rows, so a client that
//!   keeps changing its agent id only evicts rows of its own namespace;
//! - the whole file keeps at most `max_total_rows` rows, as a bound on disk
//!   use. When a store goes over it, the oldest rows of the namespace furthest
//!   above its fair share (`max_total_rows` divided by the namespaces that
//!   have rows) are deleted. A namespace at or under its fair share never
//!   loses rows to another one, and a new namespace can always store. Each
//!   namespace keeps at least one row, so with more namespaces than
//!   `max_total_rows` the file can hold slightly more rows than the limit
//!   (at most one per namespace).
//!
//! The three limits can be set with `ZN_MEMORY_MAX_AGENT_ROWS`,
//! `ZN_MEMORY_MAX_NAMESPACE_ROWS` and `ZN_MEMORY_MAX_TOTAL_ROWS` (see
//! `with_limits_from_env`).
//!
//! Row counts per namespace are kept exact by triggers in a small
//! `memory_counts` table, so the limits are checked without scanning the file.
//!
//! One connection per `VectorMemory` is opened on first use, with the schema
//! brought up to date once; WAL mode and a busy timeout let several instances
//! share the same file. Stores that still find the database busy are retried;
//! searches run on the request path and have a short total deadline instead.

use anyhow::{anyhow, Result};
use rusqlite::{
    params, Connection, ErrorCode, OptionalExtension, Transaction, TransactionBehavior,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// Errors of the vector memory that callers may want to tell apart.
#[derive(Debug, thiserror::Error)]
pub enum MemoryError {
    /// A search gave up after its deadline (it runs on the request path).
    #[error("search did not finish within {0} ms")]
    SearchDeadline(u128),
}

impl MemoryError {
    /// True when `err` is a search that gave up on purpose: past its
    /// deadline, or on a database that stayed busy for its short timeout.
    pub fn is_search_give_up(err: &anyhow::Error) -> bool {
        matches!(
            err.downcast_ref::<MemoryError>(),
            Some(MemoryError::SearchDeadline(_))
        ) || VectorMemory::is_busy(err)
    }
}

/// Rows kept per agent unless `with_max_rows` says otherwise.
pub const DEFAULT_MAX_ROWS_PER_AGENT: usize = 10_000;

/// Rows kept per namespace unless `with_max_namespace_rows` says otherwise.
pub const DEFAULT_MAX_ROWS_PER_NAMESPACE: usize = 25_000;

/// Largest value accepted for a limit from the environment.
pub const MAX_LIMIT_FROM_ENV: usize = 100_000_000;

/// Rows kept in the whole file unless `with_max_total_rows` says otherwise.
pub const DEFAULT_MAX_TOTAL_ROWS: usize = 100_000;

/// Version of the on-disk schema, stored in `PRAGMA user_version`.
const SCHEMA_VERSION: i64 = 3;

/// Namespace given to rows written before rows had one (schema 0 and 1).
/// Those rows came from every client of the gateway, so they go to the
/// global namespace of the operator rather than to any tenant.
const LEGACY_NAMESPACE: &str = crate::tenants::GLOBAL_NAMESPACE;

/// Attempts for a store that finds the database busy or locked.
const BUSY_ATTEMPTS: u32 = 5;

/// SQLite busy timeout for stores unless `with_busy_timeout` says otherwise.
const DEFAULT_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// SQLite busy timeout for searches, which are tried once.
const SEARCH_BUSY_TIMEOUT: Duration = Duration::from_millis(200);

/// Longest a search may delay the request that waits for it, including the
/// wait for this instance's connection.
const SEARCH_DEADLINE: Duration = Duration::from_secs(1);

/// At most one warning per interval; other failures go to debug level.
const WARN_INTERVAL: Duration = Duration::from_secs(600);

pub struct VectorMemory {
    base_path: String,
    dim: i32,
    model_id: String,
    max_rows: usize,
    max_namespace_rows: usize,
    max_total_rows: usize,
    busy_timeout: Duration,
    conn: Arc<Mutex<Option<Connection>>>,
    failures: FailureLog,
}

impl VectorMemory {
    pub fn new(base_path: &str, dim: i32, model_id: &str) -> Self {
        Self {
            base_path: base_path.to_string(),
            dim,
            model_id: model_id.to_string(),
            max_rows: DEFAULT_MAX_ROWS_PER_AGENT,
            max_namespace_rows: DEFAULT_MAX_ROWS_PER_NAMESPACE,
            max_total_rows: DEFAULT_MAX_TOTAL_ROWS,
            busy_timeout: DEFAULT_BUSY_TIMEOUT,
            conn: Arc::new(Mutex::new(None)),
            failures: FailureLog::new(),
        }
    }

    /// Keep at most `max_rows` rows per agent (at least 1); older rows are
    /// deleted as new ones are stored.
    pub fn with_max_rows(mut self, max_rows: usize) -> Self {
        self.max_rows = max_rows.max(1);
        self
    }

    /// Keep at most `max_namespace_rows` rows per namespace across all its
    /// agents (at least 1); the namespace's oldest rows are deleted first.
    pub fn with_max_namespace_rows(mut self, max_namespace_rows: usize) -> Self {
        self.max_namespace_rows = max_namespace_rows.max(1);
        self
    }

    /// Keep at most `max_total_rows` rows in the file (at least 1). Going
    /// over it deletes the oldest rows of the namespace furthest above its
    /// fair share. Each namespace keeps at least one row, so with more
    /// namespaces than `max_total_rows` the file can hold slightly more rows
    /// than the limit (at most one per namespace).
    pub fn with_max_total_rows(mut self, max_total_rows: usize) -> Self {
        self.max_total_rows = max_total_rows.max(1);
        self
    }

    /// Applies `ZN_MEMORY_MAX_AGENT_ROWS`, `ZN_MEMORY_MAX_NAMESPACE_ROWS` and
    /// `ZN_MEMORY_MAX_TOTAL_ROWS` when they are set to an integer from 1 to
    /// `MAX_LIMIT_FROM_ENV`; other values are ignored with a warning.
    pub fn with_limits_from_env(self) -> Self {
        self.with_limits(|name| std::env::var(name).ok())
    }

    fn with_limits(mut self, get: impl Fn(&str) -> Option<String>) -> Self {
        let read = |name: &str| -> Option<usize> {
            let raw = get(name)?;
            match raw.trim().parse::<usize>() {
                Ok(n) if (1..=MAX_LIMIT_FROM_ENV).contains(&n) => Some(n),
                _ => {
                    tracing::warn!(
                        "Ignoring {}: expected an integer from 1 to {}",
                        name,
                        MAX_LIMIT_FROM_ENV
                    );
                    None
                }
            }
        };
        if let Some(n) = read("ZN_MEMORY_MAX_AGENT_ROWS") {
            self = self.with_max_rows(n);
        }
        if let Some(n) = read("ZN_MEMORY_MAX_NAMESPACE_ROWS") {
            self = self.with_max_namespace_rows(n);
        }
        if let Some(n) = read("ZN_MEMORY_MAX_TOTAL_ROWS") {
            self = self.with_max_total_rows(n);
        }
        self
    }

    /// SQLite busy timeout for each store attempt (default 5 s).
    pub fn with_busy_timeout(mut self, busy_timeout: Duration) -> Self {
        self.busy_timeout = busy_timeout;
        self
    }

    fn safe_model(&self) -> String {
        self.model_id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect()
    }

    /// Logical name of an agent's memory: base path, model, dimension,
    /// namespace, agent.
    pub fn table_namespace(&self, namespace: &str, agent_id: &str) -> String {
        format!(
            "{}/{}_d{}/{}/{}",
            self.base_path,
            self.safe_model(),
            self.dim,
            namespace,
            agent_id
        )
    }

    fn db_path(&self) -> PathBuf {
        Path::new(&self.base_path).join(format!("{}_d{}.sqlite3", self.safe_model(), self.dim))
    }

    /// Opens the database and brings its schema to `SCHEMA_VERSION`.
    fn open(path: &Path, busy_timeout: Duration) -> Result<Connection> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut conn = Connection::open(path)?;
        conn.busy_timeout(busy_timeout)?;
        // Overwrite deleted and replaced content with zeros, so text that
        // an upgrade replaces does not stay in free pages.
        conn.execute_batch("PRAGMA secure_delete = ON;")?;
        // Switching to WAL needs an exclusive lock: only ask when the file is
        // not in WAL mode yet.
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
        if !mode.eq_ignore_ascii_case("wal") {
            conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get::<_, String>(0))?;
        }
        let tx = Transaction::new(&mut conn, TransactionBehavior::Immediate)?;
        let version: i64 = tx.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(anyhow!(
                "{} has schema version {}, this build supports up to {}",
                path.display(),
                version,
                SCHEMA_VERSION
            ));
        }
        let mut cleaned = false;
        if version < SCHEMA_VERSION {
            Self::upgrade(&tx)?;
            cleaned = version < 3;
        }
        tx.commit()?;
        if cleaned {
            // Files before schema 3 kept the text of each call. The rows now
            // hold references; compact the file so the old text does not stay
            // in free pages or in the log, and only then record schema 3. If
            // this fails the file is not used, and the next start retries.
            conn.execute_batch("VACUUM;")?;
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| {
                r.get::<_, i64>(0)
            })?;
            conn.execute_batch("PRAGMA user_version = 3;")?;
        }
        Ok(conn)
    }

    /// Replaces the text of every row that is not a reference yet with its
    /// `content_ref`. Files written before schema 3 stored the arguments of
    /// calls as text.
    fn scrub_text(tx: &Transaction<'_>) -> Result<()> {
        let rows: Vec<(i64, String)> = {
            let mut stmt = tx.prepare("SELECT id, text FROM memory")?;
            let mapped = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            let mut out = Vec::new();
            for row in mapped {
                let (id, text): (i64, String) = row?;
                if !crate::ai::is_content_ref(&text) {
                    out.push((id, text));
                }
            }
            out
        };
        for (id, text) in rows {
            tx.execute(
                "UPDATE memory SET text = ?1 WHERE id = ?2",
                params![crate::ai::content_ref(&text), id],
            )?;
        }
        let left: i64 = tx.query_row(
            "SELECT COUNT(*) FROM memory WHERE NOT (text GLOB 'h:[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')",
            [],
            |r| r.get(0),
        )?;
        if left != 0 {
            return Err(anyhow!(
                "{left} vector rows still hold text after the cleanup"
            ));
        }
        Ok(())
    }

    /// Brings a schema 0 (new file, or written before versioning) or schema 1
    /// file to schema 2, in place: rows without a namespace get
    /// `LEGACY_NAMESPACE`, and the per-namespace row counts are filled in.
    fn upgrade(tx: &Transaction<'_>) -> Result<()> {
        tx.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS memory (
                 id INTEGER PRIMARY KEY,
                 namespace TEXT NOT NULL DEFAULT '{LEGACY_NAMESPACE}',
                 agent_id TEXT NOT NULL,
                 text TEXT NOT NULL,
                 vector BLOB NOT NULL
             );"
        ))?;
        let has_namespace: i64 = tx.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('memory') WHERE name = 'namespace'",
            [],
            |r| r.get(0),
        )?;
        if has_namespace == 0 {
            tx.execute_batch(&format!(
                "ALTER TABLE memory ADD COLUMN namespace TEXT NOT NULL DEFAULT '{LEGACY_NAMESPACE}';"
            ))?;
        }
        // (namespace, agent_id) serves searches and the per-agent limit;
        // (namespace) keeps a namespace's rows in id order for its limits.
        tx.execute_batch(
            "DROP INDEX IF EXISTS memory_agent;
             CREATE INDEX IF NOT EXISTS memory_namespace_agent ON memory(namespace, agent_id);
             CREATE INDEX IF NOT EXISTS memory_namespace ON memory(namespace);
             CREATE TABLE IF NOT EXISTS memory_counts (
                 namespace TEXT PRIMARY KEY,
                 row_count INTEGER NOT NULL
             ) WITHOUT ROWID;
             DELETE FROM memory_counts;
             INSERT INTO memory_counts (namespace, row_count)
                 SELECT namespace, COUNT(*) FROM memory GROUP BY namespace;
             CREATE TRIGGER IF NOT EXISTS memory_count_insert AFTER INSERT ON memory
             BEGIN
                 INSERT OR IGNORE INTO memory_counts (namespace, row_count)
                     VALUES (NEW.namespace, 0);
                 UPDATE memory_counts SET row_count = row_count + 1
                     WHERE namespace = NEW.namespace;
             END;
             CREATE TRIGGER IF NOT EXISTS memory_count_delete AFTER DELETE ON memory
             BEGIN
                 UPDATE memory_counts SET row_count = row_count - 1
                     WHERE namespace = OLD.namespace;
                 DELETE FROM memory_counts WHERE namespace = OLD.namespace AND row_count <= 0;
             END;
             PRAGMA user_version = 2;",
        )?;
        Self::scrub_text(tx)?;
        Ok(())
    }

    /// Deletes the `n` oldest rows of `namespace`.
    fn delete_oldest(tx: &Transaction<'_>, namespace: &str, n: i64) -> Result<()> {
        tx.execute(
            "DELETE FROM memory WHERE id IN (
                 SELECT id FROM memory WHERE namespace = ?1
                 ORDER BY id LIMIT ?2
             )",
            params![namespace, n],
        )?;
        Ok(())
    }

    /// True for SQLite "database is busy / locked" errors, which are worth a retry.
    fn is_busy(err: &anyhow::Error) -> bool {
        matches!(
            err.downcast_ref::<rusqlite::Error>(),
            Some(rusqlite::Error::SqliteFailure(e, _))
                if e.code == ErrorCode::DatabaseBusy || e.code == ErrorCode::DatabaseLocked
        )
    }

    /// Locks the connection slot. A panic in an earlier holder poisons the
    /// mutex: the connection is dropped (it is reopened on next use) and the
    /// poison is cleared, instead of disabling the memory until restart.
    fn lock_slot(slot: &Mutex<Option<Connection>>) -> MutexGuard<'_, Option<Connection>> {
        match slot.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                let mut guard = poisoned.into_inner();
                *guard = None;
                slot.clear_poison();
                guard
            }
        }
    }

    /// Runs `f` on this instance's connection, opening it on first use, and
    /// makes up to `attempts` attempts while the database is busy. With
    /// `create` false and no database file yet, returns `Ok(None)` without
    /// creating one.
    fn with_conn<T>(
        slot: &Mutex<Option<Connection>>,
        path: &Path,
        create: bool,
        attempts: u32,
        busy_timeout: Duration,
        mut f: impl FnMut(&mut Connection) -> Result<T>,
    ) -> Result<Option<T>> {
        let mut attempt: u32 = 0;
        loop {
            attempt += 1;
            match Self::try_with_conn(slot, path, create, busy_timeout, &mut f) {
                Err(e) if attempt < attempts && Self::is_busy(&e) => {
                    std::thread::sleep(Duration::from_millis(50 * u64::from(attempt)));
                }
                other => return other,
            }
        }
    }

    fn try_with_conn<T>(
        slot: &Mutex<Option<Connection>>,
        path: &Path,
        create: bool,
        busy_timeout: Duration,
        f: &mut impl FnMut(&mut Connection) -> Result<T>,
    ) -> Result<Option<T>> {
        let mut guard = Self::lock_slot(slot);
        if guard.is_none() {
            if !create && !path.exists() {
                return Ok(None);
            }
            *guard = Some(Self::open(path, busy_timeout)?);
        }
        let conn = guard.as_mut().expect("connection opened above");
        // Stores and searches share the connection with different timeouts.
        conn.busy_timeout(busy_timeout)?;
        f(conn).map(Some)
    }

    fn check_vector(&self, vector: &[f32]) -> Result<()> {
        if vector.len() != self.dim as usize {
            return Err(anyhow!(
                "vector has {} dimensions, memory expects {}",
                vector.len(),
                self.dim
            ));
        }
        if !vector.iter().all(|v| v.is_finite()) {
            return Err(anyhow!("vector contains NaN or infinite values"));
        }
        Ok(())
    }

    /// Store a vector embedding for an agent of `namespace`, keeping only the
    /// agent's most recent `max_rows` rows, the namespace's most recent
    /// `max_namespace_rows` rows, and at most `max_total_rows` rows in the
    /// file (by deleting the oldest rows of the namespace furthest above its
    /// fair share).
    ///
    /// `namespace` must come from the authenticated caller, never from the
    /// message itself.
    pub async fn store(
        &self,
        namespace: &str,
        agent_id: &str,
        text: &str,
        vector: &[f32],
    ) -> Result<()> {
        self.check_vector(vector)?;
        let path = self.db_path();
        let slot = Arc::clone(&self.conn);
        // Limits set through the API can be any usize: never let one wrap
        // to a negative number, which would delete everything.
        let max_rows = i64::try_from(self.max_rows).unwrap_or(i64::MAX);
        let max_namespace = i64::try_from(self.max_namespace_rows).unwrap_or(i64::MAX);
        let max_total = i64::try_from(self.max_total_rows).unwrap_or(i64::MAX);
        let busy_timeout = self.busy_timeout;
        let ns = namespace.to_string();
        let agent = agent_id.to_string();
        let text = text.to_string();
        let blob: Vec<u8> = vector.iter().flat_map(|v| v.to_le_bytes()).collect();
        let result = tokio::task::spawn_blocking(move || -> Result<()> {
            Self::with_conn(&slot, &path, true, BUSY_ATTEMPTS, busy_timeout, |conn| {
                // One transaction: a single commit, and the insert and the
                // pruning are applied together.
                let tx = Transaction::new(conn, TransactionBehavior::Immediate)?;
                tx.execute(
                    "INSERT INTO memory (namespace, agent_id, text, vector) VALUES (?1, ?2, ?3, ?4)",
                    params![ns, agent, text, blob],
                )?;
                tx.execute(
                    "DELETE FROM memory WHERE namespace = ?1 AND agent_id = ?2 AND id <= (
                         SELECT id FROM memory WHERE namespace = ?1 AND agent_id = ?2
                         ORDER BY id DESC LIMIT 1 OFFSET ?3
                     )",
                    params![ns, agent, max_rows],
                )?;
                // Exact counts, kept by triggers: no scan of the file.
                let namespace_rows: i64 = tx.query_row(
                    "SELECT COALESCE(SUM(row_count), 0) FROM memory_counts WHERE namespace = ?1",
                    params![ns],
                    |r| r.get(0),
                )?;
                // The namespace limit only prunes the writing namespace.
                if namespace_rows > max_namespace {
                    Self::delete_oldest(&tx, &ns, namespace_rows - max_namespace)?;
                }
                // The file limit prunes the namespace furthest above its fair
                // share, so a namespace at or under it never loses rows to
                // another one and a new namespace can always store. Each round
                // deletes at least one row, and the loop also stops (break)
                // when no namespace is above its share, so it always ends.
                let mut excess: i64 = tx.query_row(
                    "SELECT COALESCE(SUM(row_count), 0) - ?1 FROM memory_counts",
                    params![max_total],
                    |r| r.get(0),
                )?;
                while excess > 0 {
                    let namespaces: i64 =
                        tx.query_row("SELECT COUNT(*) FROM memory_counts", [], |r| r.get(0))?;
                    // At least one row each, so the writer keeps its new row
                    // even with more namespaces than the file limit.
                    let fair = (max_total / namespaces.max(1)).max(1);
                    let over: Option<(String, i64)> = tx
                        .query_row(
                            "SELECT namespace, row_count FROM memory_counts
                             WHERE row_count > ?1
                             ORDER BY row_count DESC, namespace LIMIT 1",
                            params![fair],
                            |r| Ok((r.get(0)?, r.get(1)?)),
                        )
                        .optional()?;
                    let Some((victim, rows)) = over else { break };
                    let n = excess.min(rows - fair);
                    Self::delete_oldest(&tx, &victim, n)?;
                    excess -= n;
                }
                tx.commit()?;
                Ok(())
            })?;
            Ok(())
        })
        .await
        .map_err(anyhow::Error::from)
        .and_then(|r| r);
        if let Err(e) = &result {
            self.failures.report("store", e);
        }
        result
    }

    /// Nearest stored texts for an agent of `namespace`, closest first, as
    /// (text, squared L2 distance).
    ///
    /// Searches run on the request path: a search is tried once, with a
    /// short busy timeout, and gives up after `SEARCH_DEADLINE` in total.
    pub async fn search(
        &self,
        namespace: &str,
        agent_id: &str,
        vector: &[f32],
        limit: usize,
    ) -> Result<Vec<(String, f32)>> {
        self.check_vector(vector)?;
        if limit == 0 {
            return Ok(vec![]);
        }
        let path = self.db_path();
        let slot = Arc::clone(&self.conn);
        let ns = namespace.to_string();
        let agent = agent_id.to_string();
        let query = vector.to_vec();
        let job = tokio::task::spawn_blocking(move || -> Result<Vec<(String, f32)>> {
            let found = Self::with_conn(&slot, &path, false, 1, SEARCH_BUSY_TIMEOUT, |conn| {
                let mut stmt = conn.prepare_cached(
                    "SELECT text, vector FROM memory WHERE namespace = ?1 AND agent_id = ?2",
                )?;
                let mut rows = stmt.query(params![ns, agent])?;
                let mut best: Vec<(String, f32)> = Vec::new();
                while let Some(row) = rows.next()? {
                    let blob: Vec<u8> = row.get(1)?;
                    if blob.len() != query.len() * 4 {
                        continue;
                    }
                    let d: f32 = blob
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .zip(&query)
                        .map(|(b, q)| {
                            let v = f32::from_le_bytes(*b);
                            (v - q) * (v - q)
                        })
                        .sum();
                    // Rows written before non-finite input was rejected, or values
                    // that overflow, must not break the ordering of the top-k list.
                    if !d.is_finite() {
                        continue;
                    }
                    if best.len() < limit || d < best[best.len() - 1].1 {
                        let text: String = row.get(0)?;
                        let pos = best.partition_point(|(_, bd)| *bd <= d);
                        best.insert(pos, (text, d));
                        best.truncate(limit);
                    }
                }
                Ok(best)
            })?;
            Ok(found.unwrap_or_default())
        });
        // The blocking task cannot be cancelled; past the deadline the request
        // goes on without it and the task finishes on its own.
        let result = match tokio::time::timeout(SEARCH_DEADLINE, job).await {
            Ok(joined) => joined.map_err(anyhow::Error::from).and_then(|r| r),
            Err(_) => Err(MemoryError::SearchDeadline(SEARCH_DEADLINE.as_millis()).into()),
        };
        if let Err(e) = &result {
            self.failures.report("search", e);
        }
        result
    }
}

/// Rate limit for failure logs: at most one warning per `WARN_INTERVAL`, the
/// rest at debug level, so a broken memory file is visible (also when it
/// breaks again later) without flooding the log.
struct FailureLog {
    last_warning: Mutex<Option<Instant>>,
    /// Failures logged at debug level since the last warning.
    suppressed: AtomicU64,
}

impl FailureLog {
    fn new() -> Self {
        Self {
            last_warning: Mutex::new(None),
            suppressed: AtomicU64::new(0),
        }
    }

    /// Some(n) when a failure at `now` is to be logged as a warning, with `n`
    /// the failures logged at debug level since the previous warning; None
    /// when it goes to debug level.
    fn warn_now(&self, now: Instant) -> Option<u64> {
        let mut last = self
            .last_warning
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        match *last {
            Some(at) if now.saturating_duration_since(at) < WARN_INTERVAL => {
                self.suppressed.fetch_add(1, Ordering::Relaxed);
                None
            }
            _ => {
                *last = Some(now);
                Some(self.suppressed.swap(0, Ordering::Relaxed))
            }
        }
    }

    fn report(&self, op: &str, err: &anyhow::Error) {
        match self.warn_now(Instant::now()) {
            Some(0) => tracing::warn!(
                "Vector memory {} failed (further failures in the next {} s are logged at debug level): {:#}",
                op,
                WARN_INTERVAL.as_secs(),
                err
            ),
            Some(n) => tracing::warn!(
                "Vector memory {} failed ({} earlier failures were logged at debug level): {:#}",
                op,
                n,
                err
            ),
            None => tracing::debug!("Vector memory {} failed: {:#}", op, err),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NS: &str = "acme";

    #[test]
    fn namespace_includes_model_id_and_dim() {
        let a = VectorMemory::new("/tmp/v", 384, "minilm-v2");
        let b = VectorMemory::new("/tmp/v", 768, "minilm-v2");
        let c = VectorMemory::new("/tmp/v", 384, "other-model");
        assert_ne!(
            a.table_namespace(NS, "agent"),
            b.table_namespace(NS, "agent")
        );
        assert_ne!(
            a.table_namespace(NS, "agent"),
            c.table_namespace(NS, "agent")
        );
        assert_ne!(
            a.table_namespace(NS, "agent"),
            a.table_namespace("other", "agent")
        );
        assert!(a.table_namespace(NS, "agent").contains("minilm_v2_d384"));
        assert_ne!(a.db_path(), b.db_path());
        assert_ne!(a.db_path(), c.db_path());
    }

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zn-mem-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    async fn texts_in(m: &VectorMemory, ns: &str, agent: &str, dim: usize) -> Vec<String> {
        let mut t: Vec<String> = m
            .search(ns, agent, &vec![0.0; dim], 1_000)
            .await
            .unwrap()
            .into_iter()
            .map(|(t, _)| t)
            .collect();
        t.sort();
        t
    }

    async fn texts(m: &VectorMemory, agent: &str, dim: usize) -> Vec<String> {
        texts_in(m, NS, agent, dim).await
    }

    /// A search that gave up on purpose: past its deadline or on a busy database.
    fn gave_up(e: &anyhow::Error) -> bool {
        MemoryError::is_search_give_up(e)
    }

    /// Rows per namespace, read with a separate connection, after checking
    /// that the trigger-kept counts match them.
    fn rows_per_namespace(m: &VectorMemory) -> Vec<(String, i64)> {
        let raw = Connection::open(m.db_path()).unwrap();
        let read = |sql: &str| -> Vec<(String, i64)> {
            raw.prepare(sql)
                .unwrap()
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        };
        let actual =
            read("SELECT namespace, COUNT(*) FROM memory GROUP BY namespace ORDER BY namespace");
        let counted = read("SELECT namespace, row_count FROM memory_counts ORDER BY namespace");
        assert_eq!(actual, counted, "memory_counts out of step with the rows");
        actual
    }

    #[tokio::test]
    async fn search_returns_nearest_first_with_squared_l2() {
        let dir = temp_dir("nearest");
        let m = VectorMemory::new(dir.to_str().unwrap(), 3, "m");
        assert!(m
            .search(NS, "a", &[0.0, 0.0, 0.0], 5)
            .await
            .unwrap()
            .is_empty());
        assert!(!m.db_path().exists(), "search must not create the file");
        m.store(NS, "a", "far", &[3.0, 0.0, 0.0]).await.unwrap();
        m.store(NS, "a", "near", &[1.0, 0.0, 0.0]).await.unwrap();
        m.store(NS, "a", "mid", &[0.0, 2.0, 0.0]).await.unwrap();
        m.store(NS, "b", "other agent", &[0.0, 0.0, 0.0])
            .await
            .unwrap();
        let r = m.search(NS, "a", &[0.0, 0.0, 0.0], 2).await.unwrap();
        assert_eq!(r, vec![("near".to_string(), 1.0), ("mid".to_string(), 4.0)]);
        let r = m.search(NS, "a", &[0.0, 0.0, 0.0], 10).await.unwrap();
        assert_eq!(r.len(), 3);
        assert_eq!(r[2], ("far".to_string(), 9.0));
        assert!(m
            .search(NS, "nobody", &[0.0, 0.0, 0.0], 1)
            .await
            .unwrap()
            .is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn wrong_dimension_is_rejected() {
        let dir = temp_dir("dim");
        let m = VectorMemory::new(dir.to_str().unwrap(), 3, "m");
        assert!(m.store(NS, "a", "x", &[1.0, 2.0]).await.is_err());
        assert!(m.search(NS, "a", &[1.0], 1).await.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn non_finite_vectors_are_rejected_and_skipped() {
        let dir = temp_dir("finite");
        let m = VectorMemory::new(dir.to_str().unwrap(), 2, "m");
        assert!(m.store(NS, "a", "nan", &[f32::NAN, 0.0]).await.is_err());
        assert!(m
            .store(NS, "a", "inf", &[f32::INFINITY, 0.0])
            .await
            .is_err());
        assert!(m.search(NS, "a", &[0.0, f32::NAN], 1).await.is_err());

        // A row that bypassed validation must not displace valid results.
        m.store(NS, "a", "near", &[1.0, 0.0]).await.unwrap();
        let blob: Vec<u8> = [f32::NAN, 0.0f32]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        Connection::open(m.db_path())
            .unwrap()
            .execute(
                "INSERT INTO memory (namespace, agent_id, text, vector) VALUES (?1, ?2, ?3, ?4)",
                params![NS, "a", "bad", blob],
            )
            .unwrap();
        m.store(NS, "a", "far", &[2.0, 0.0]).await.unwrap();
        let r = m.search(NS, "a", &[0.0, 0.0], 5).await.unwrap();
        assert_eq!(r, vec![("near".to_string(), 1.0), ("far".to_string(), 4.0)]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn each_agent_keeps_only_its_most_recent_rows() {
        let dir = temp_dir("retention");
        let m = VectorMemory::new(dir.to_str().unwrap(), 1, "m").with_max_rows(3);
        for i in 0..6 {
            m.store(NS, "a", &format!("a{i}"), &[i as f32])
                .await
                .unwrap();
        }
        m.store(NS, "b", "b0", &[0.0]).await.unwrap();
        assert_eq!(texts(&m, "a", 1).await, vec!["a3", "a4", "a5"]);
        // Another agent's rows are not affected.
        assert_eq!(texts(&m, "b", 1).await, vec!["b0"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn the_whole_file_keeps_only_its_most_recent_rows() {
        let dir = temp_dir("total");
        let m = VectorMemory::new(dir.to_str().unwrap(), 1, "m").with_max_total_rows(4);
        // Rotating agent ids cannot grow the file past the total limit.
        for i in 0..10 {
            m.store(NS, &format!("agent{i}"), &format!("t{i}"), &[0.0])
                .await
                .unwrap();
        }
        let raw = Connection::open(m.db_path()).unwrap();
        let mut all: Vec<String> = raw
            .prepare("SELECT text FROM memory")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        all.sort();
        assert_eq!(all, vec!["t6", "t7", "t8", "t9"]);
        assert_eq!(rows_per_namespace(&m), vec![(NS.to_string(), 4)]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn namespaces_are_isolated_and_evict_only_above_their_fair_share() {
        let dir = temp_dir("namespaces");
        let m = VectorMemory::new(dir.to_str().unwrap(), 1, "m")
            .with_max_namespace_rows(3)
            .with_max_total_rows(5);
        m.store("victim", "a", "v0", &[0.0]).await.unwrap();
        m.store("victim", "a", "v1", &[0.0]).await.unwrap();

        // The same agent id in another namespace is another memory.
        m.store("flood", "a", "f-a", &[0.0]).await.unwrap();
        assert_eq!(texts_in(&m, "victim", "a", 1).await, vec!["v0", "v1"]);
        assert_eq!(texts_in(&m, "flood", "a", 1).await, vec!["f-a"]);

        // Rotating agent ids only evicts rows of the flooding namespace.
        for i in 0..20 {
            m.store("flood", &format!("agent{i}"), &format!("f{i}"), &[0.0])
                .await
                .unwrap();
        }
        assert_eq!(texts_in(&m, "victim", "a", 1).await, vec!["v0", "v1"]);
        assert_eq!(
            rows_per_namespace(&m),
            vec![("flood".to_string(), 3), ("victim".to_string(), 2)]
        );
        assert_eq!(texts_in(&m, "flood", "agent19", 1).await, vec!["f19"]);
        assert!(texts_in(&m, "flood", "a", 1).await.is_empty());

        // The file is full (5 rows). A new namespace still stores: the row
        // comes from the namespace furthest above its fair share (5 / 3 = 1),
        // the flooding one, and the victim keeps its rows.
        m.store("late", "a", "l0", &[0.0]).await.unwrap();
        assert_eq!(texts_in(&m, "late", "a", 1).await, vec!["l0"]);
        assert_eq!(texts_in(&m, "victim", "a", 1).await, vec!["v0", "v1"]);
        assert_eq!(
            rows_per_namespace(&m),
            vec![
                ("flood".to_string(), 2),
                ("late".to_string(), 1),
                ("victim".to_string(), 2)
            ]
        );
        // More flooding only takes rows from the flooding namespace.
        for i in 20..30 {
            m.store("flood", &format!("agent{i}"), &format!("f{i}"), &[0.0])
                .await
                .unwrap();
        }
        assert_eq!(texts_in(&m, "victim", "a", 1).await, vec!["v0", "v1"]);
        assert_eq!(texts_in(&m, "late", "a", 1).await, vec!["l0"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_full_file_shares_space_fairly_between_namespaces() {
        let dir = temp_dir("fair");
        let m = VectorMemory::new(dir.to_str().unwrap(), 1, "m").with_max_total_rows(10);
        for i in 0..10 {
            m.store("a", &format!("a{i}"), "x", &[0.0]).await.unwrap();
        }
        // "b" grows while "a" is above its fair share (10 / 2 = 5), then
        // stops at the fair share itself once both are there.
        for i in 0..6 {
            m.store("b", &format!("b{i}"), "y", &[0.0]).await.unwrap();
        }
        assert_eq!(
            rows_per_namespace(&m),
            vec![("a".to_string(), 5), ("b".to_string(), 5)]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn limits_come_from_the_environment() {
        let env = |name: &str| -> Option<String> {
            match name {
                "ZN_MEMORY_MAX_AGENT_ROWS" => Some("7".to_string()),
                "ZN_MEMORY_MAX_NAMESPACE_ROWS" => Some(" 70 ".to_string()),
                "ZN_MEMORY_MAX_TOTAL_ROWS" => Some("0".to_string()),
                _ => None,
            }
        };
        let m = VectorMemory::new("/tmp/v", 1, "m").with_limits(env);
        assert_eq!(m.max_rows, 7);
        assert_eq!(m.max_namespace_rows, 70);
        // Zero is not a positive integer: the default stays.
        assert_eq!(m.max_total_rows, DEFAULT_MAX_TOTAL_ROWS);
        let none = VectorMemory::new("/tmp/v", 1, "m").with_limits(|_| None);
        assert_eq!(none.max_rows, DEFAULT_MAX_ROWS_PER_AGENT);

        // Out of range or negative values are ignored: the defaults stay.
        let bad = |name: &str| -> Option<String> {
            match name {
                "ZN_MEMORY_MAX_AGENT_ROWS" => Some("18446744073709551615".to_string()),
                "ZN_MEMORY_MAX_NAMESPACE_ROWS" => Some("-5".to_string()),
                "ZN_MEMORY_MAX_TOTAL_ROWS" => Some((MAX_LIMIT_FROM_ENV + 1).to_string()),
                _ => None,
            }
        };
        let m = VectorMemory::new("/tmp/v", 1, "m").with_limits(bad);
        assert_eq!(m.max_rows, DEFAULT_MAX_ROWS_PER_AGENT);
        assert_eq!(m.max_namespace_rows, DEFAULT_MAX_ROWS_PER_NAMESPACE);
        assert_eq!(m.max_total_rows, DEFAULT_MAX_TOTAL_ROWS);

        // The upper bound itself is accepted.
        let edge = VectorMemory::new("/tmp/v", 1, "m").with_limits(|name| {
            (name == "ZN_MEMORY_MAX_TOTAL_ROWS").then(|| MAX_LIMIT_FROM_ENV.to_string())
        });
        assert_eq!(edge.max_total_rows, MAX_LIMIT_FROM_ENV);
        assert_eq!(edge.max_rows, DEFAULT_MAX_ROWS_PER_AGENT);
    }

    #[tokio::test]
    async fn huge_limits_from_the_api_keep_every_row() {
        let dir = temp_dir("huge-limits");
        let m = VectorMemory::new(dir.to_str().unwrap(), 1, "m")
            .with_max_rows(usize::MAX)
            .with_max_namespace_rows(usize::MAX)
            .with_max_total_rows(usize::MAX);
        for i in 0..3 {
            m.store(NS, "a", &format!("t{i}"), &[0.0]).await.unwrap();
        }
        assert_eq!(texts(&m, "a", 1).await, vec!["t0", "t1", "t2"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn more_namespaces_than_the_file_limit_still_store() {
        let dir = temp_dir("tiny-total");
        let m = VectorMemory::new(dir.to_str().unwrap(), 1, "m").with_max_total_rows(3);
        for ns in ["b", "c", "d"] {
            m.store(ns, "a", ns, &[0.0]).await.unwrap();
        }
        // A fourth namespace in a full file keeps its new row.
        m.store("a", "a", "a", &[0.0]).await.unwrap();
        assert_eq!(texts_in(&m, "a", "a", 1).await, vec!["a"]);
        let total: i64 = rows_per_namespace(&m).iter().map(|(_, n)| n).sum();
        assert!(total <= 4, "{total} rows");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn schema_version_is_recorded_and_newer_files_are_refused() {
        let dir = temp_dir("schema");
        let m = VectorMemory::new(dir.to_str().unwrap(), 1, "m");
        m.store(NS, "a", "x", &[1.0]).await.unwrap();
        let raw = Connection::open(m.db_path()).unwrap();
        let v: i64 = raw
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION);

        raw.execute_batch("PRAGMA user_version = 99;").unwrap();
        let newer = VectorMemory::new(dir.to_str().unwrap(), 1, "m");
        assert!(newer.store(NS, "a", "y", &[1.0]).await.is_err());
        assert!(newer.search(NS, "a", &[1.0], 1).await.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Writes a file as an earlier release did: the table without a
    /// namespace column, one row for agent "a", and `version`.
    fn write_old_file(m: &VectorMemory, dir: &Path, version: i64) -> Connection {
        std::fs::create_dir_all(dir).unwrap();
        let raw = Connection::open(m.db_path()).unwrap();
        raw.execute_batch(&format!(
            "CREATE TABLE memory (
                 id INTEGER PRIMARY KEY,
                 agent_id TEXT NOT NULL,
                 text TEXT NOT NULL,
                 vector BLOB NOT NULL
             );
             CREATE INDEX memory_agent ON memory(agent_id);
             PRAGMA user_version = {version};"
        ))
        .unwrap();
        raw.execute(
            "INSERT INTO memory (agent_id, text, vector) VALUES ('a', 'old', ?1)",
            params![2.0f32.to_le_bytes().to_vec()],
        )
        .unwrap();
        raw
    }

    fn zn_ref(text: &str) -> String {
        crate::ai::content_ref(text)
    }

    #[tokio::test]
    async fn old_text_rows_become_references_and_leave_no_text_in_the_files() {
        let dir = temp_dir("scrubtext");
        let m = VectorMemory::new(dir.to_str().unwrap(), 1, "m");
        let raw = write_old_file(&m, &dir, 2);
        raw.execute(
            "INSERT INTO memory (agent_id, text, vector) VALUES ('a', 'PIN is 4821 recovery_code', ?1)",
            params![1.0f32.to_le_bytes().to_vec()],
        )
        .unwrap();
        drop(raw);

        let found = m.search(LEGACY_NAMESPACE, "a", &[0.0], 5).await.unwrap();
        assert_eq!(found.len(), 2);
        assert!(found.iter().all(|(t, _)| crate::ai::is_content_ref(t)));
        for entry in std::fs::read_dir(&dir).unwrap() {
            let bytes = std::fs::read(entry.unwrap().path()).unwrap();
            let hay = String::from_utf8_lossy(&bytes);
            assert!(!hay.contains("4821") && !hay.contains("recovery_code"));
        }
        let raw = Connection::open(m.db_path()).unwrap();
        let v: i64 = raw
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_file_whose_cleanup_fails_is_not_used() {
        let dir = temp_dir("scrubfail");
        let m = VectorMemory::new(dir.to_str().unwrap(), 1, "m");
        let raw = write_old_file(&m, &dir, 2);
        raw.execute_batch(
            "CREATE TABLE memory_counts (namespace TEXT PRIMARY KEY, row_count INTEGER NOT NULL) WITHOUT ROWID;
             CREATE TRIGGER block_update BEFORE UPDATE ON memory
             BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
        )
        .unwrap();
        raw.execute_batch(
            "ALTER TABLE memory ADD COLUMN namespace TEXT NOT NULL DEFAULT '__legacy__';",
        )
        .ok();
        drop(raw);
        assert!(m.search(LEGACY_NAMESPACE, "a", &[0.0], 5).await.is_err());
        assert!(m.store(NS, "a", "x", &[1.0]).await.is_err());
        let raw = Connection::open(m.db_path()).unwrap();
        let text: String = raw
            .query_row("SELECT text FROM memory", [], |r| r.get(0))
            .unwrap();
        assert_eq!(text, "old", "a failed cleanup must change nothing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn older_files_are_upgraded_in_place() {
        for version in [0, 1] {
            let dir = temp_dir(&format!("migrate{version}"));
            let m = VectorMemory::new(dir.to_str().unwrap(), 1, "m");
            let raw = write_old_file(&m, &dir, version);

            // Old rows go to the global namespace, not to any tenant.
            assert!(m.search(NS, "a", &[0.0], 5).await.unwrap().is_empty());
            assert_eq!(
                m.search(LEGACY_NAMESPACE, "a", &[0.0], 5).await.unwrap(),
                vec![(zn_ref("old"), 4.0)]
            );
            let v: i64 = raw
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            assert_eq!(v, SCHEMA_VERSION);
            let old_index: i64 = raw
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = 'memory_agent'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(old_index, 0);
            assert_eq!(
                rows_per_namespace(&m),
                vec![(LEGACY_NAMESPACE.to_string(), 1)]
            );

            m.store(NS, "a", "new", &[1.0]).await.unwrap();
            assert_eq!(texts(&m, "a", 1).await, vec!["new"]);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn a_poisoned_lock_is_recovered() {
        let slot = Arc::new(Mutex::new(Some(Connection::open_in_memory().unwrap())));
        let s = Arc::clone(&slot);
        let _ = std::thread::spawn(move || {
            let _guard = s.lock().unwrap();
            panic!("poison the lock");
        })
        .join();
        assert!(slot.is_poisoned());
        let guard = VectorMemory::lock_slot(&slot);
        assert!(
            guard.is_none(),
            "the connection is dropped and reopened later"
        );
        drop(guard);
        assert!(!slot.is_poisoned());
    }

    #[test]
    fn failures_warn_at_most_once_per_interval() {
        let log = FailureLog::new();
        let t0 = Instant::now();
        assert_eq!(log.warn_now(t0), Some(0));
        assert_eq!(log.warn_now(t0 + Duration::from_secs(1)), None);
        assert_eq!(log.warn_now(t0 + WARN_INTERVAL / 2), None);
        // A failure after the interval is a warning again, with the count of
        // the ones logged at debug level in between.
        assert_eq!(log.warn_now(t0 + WARN_INTERVAL), Some(2));
        assert_eq!(log.warn_now(t0 + WARN_INTERVAL * 2), Some(0));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_busy_database_is_retried() {
        let dir = temp_dir("busy");
        // A busy timeout far shorter than the lock below, so the store only
        // succeeds through its retries.
        let m = VectorMemory::new(dir.to_str().unwrap(), 1, "m")
            .with_busy_timeout(Duration::from_millis(10));
        m.store(NS, "a", "first", &[0.0]).await.unwrap();

        let path = m.db_path();
        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let other = Connection::open(path).unwrap();
            other.execute_batch("BEGIN EXCLUSIVE").unwrap();
            locked_tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(200));
            other.execute_batch("COMMIT").unwrap();
        });
        locked_rx.recv().unwrap();
        m.store(NS, "a", "second", &[0.0]).await.unwrap();
        holder.join().unwrap();
        assert_eq!(texts(&m, "a", 1).await, vec!["first", "second"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_search_gives_up_after_its_deadline() {
        let dir = temp_dir("deadline");
        let m = VectorMemory::new(dir.to_str().unwrap(), 1, "m");
        m.store(NS, "a", "x", &[0.0]).await.unwrap();

        // Hold this instance's connection, as a long store would.
        let slot = Arc::clone(&m.conn);
        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let holder = std::thread::spawn(move || {
            let _guard = slot.lock().unwrap();
            locked_tx.send(()).unwrap();
            std::thread::sleep(SEARCH_DEADLINE * 2);
        });
        locked_rx.recv().unwrap();
        let start = Instant::now();
        let err = m.search(NS, "a", &[0.0], 1).await.unwrap_err();
        assert!(start.elapsed() < SEARCH_DEADLINE + Duration::from_millis(500));
        assert!(matches!(
            err.downcast_ref::<MemoryError>(),
            Some(MemoryError::SearchDeadline(_))
        ));
        assert!(MemoryError::is_search_give_up(&err));
        holder.join().unwrap();
        assert_eq!(texts(&m, "a", 1).await, vec!["x"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_stores_and_searches_share_the_file() {
        let dir = temp_dir("concurrent");
        let base = dir.to_str().unwrap().to_string();
        // Two instances on the same new file, as the proxy and the API server use.
        let a = Arc::new(VectorMemory::new(&base, 2, "m"));
        let b = Arc::new(VectorMemory::new(&base, 2, "m"));
        let mut tasks = Vec::new();
        for i in 0..64 {
            let m = if i % 2 == 0 {
                Arc::clone(&a)
            } else {
                Arc::clone(&b)
            };
            tasks.push(tokio::spawn(async move {
                let agent = format!("agent{}", i % 4);
                m.store(NS, &agent, &format!("t{i}"), &[i as f32, 1.0])
                    .await?;
                // Searches run on the request path and give up under heavy
                // contention (deadline or busy database) by design; any
                // other error is a failure. Every store must succeed.
                match m.search(NS, &agent, &[0.0, 0.0], 3).await {
                    Ok(_) => Ok(()),
                    Err(e) if gave_up(&e) => Ok(()),
                    Err(e) => Err(e),
                }
            }));
        }
        for t in tasks {
            t.await.unwrap().unwrap();
        }
        let mut total = 0;
        for agent in 0..4 {
            total += texts(&a, &format!("agent{agent}"), 2).await.len();
        }
        assert_eq!(total, 64);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_stores_respect_the_per_agent_limit() {
        let dir = temp_dir("concurrent-limit");
        let base = dir.to_str().unwrap().to_string();
        let a = Arc::new(VectorMemory::new(&base, 1, "m").with_max_rows(5));
        let b = Arc::new(VectorMemory::new(&base, 1, "m").with_max_rows(5));
        let mut tasks = Vec::new();
        for i in 0..64 {
            let m = if i % 2 == 0 {
                Arc::clone(&a)
            } else {
                Arc::clone(&b)
            };
            tasks.push(tokio::spawn(async move {
                m.store(
                    NS,
                    &format!("agent{}", i % 4),
                    &format!("t{i}"),
                    &[i as f32],
                )
                .await
            }));
        }
        for t in tasks {
            t.await.unwrap().unwrap();
        }
        for agent in 0..4 {
            assert_eq!(texts(&a, &format!("agent{agent}"), 1).await.len(), 5);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_floods_respect_the_namespace_and_total_limits() {
        let dir = temp_dir("concurrent-namespaces");
        let base = dir.to_str().unwrap().to_string();
        let limits = |m: VectorMemory| m.with_max_namespace_rows(5).with_max_total_rows(8);
        let a = Arc::new(limits(VectorMemory::new(&base, 1, "m")));
        let b = Arc::new(limits(VectorMemory::new(&base, 1, "m")));
        for i in 0..3 {
            a.store("victim", "v", &format!("v{i}"), &[0.0])
                .await
                .unwrap();
        }
        let mut tasks = Vec::new();
        for i in 0..64 {
            let m = if i % 2 == 0 {
                Arc::clone(&a)
            } else {
                Arc::clone(&b)
            };
            tasks.push(tokio::spawn(async move {
                m.store("flood", &format!("agent{i}"), &format!("f{i}"), &[0.0])
                    .await
            }));
        }
        for t in tasks {
            t.await.unwrap().unwrap();
        }
        // 3 + 5 = 8 rows: the namespace limit binds and the total holds.
        assert_eq!(
            rows_per_namespace(&a),
            vec![("flood".to_string(), 5), ("victim".to_string(), 3)]
        );
        assert_eq!(texts_in(&b, "victim", "v", 1).await, vec!["v0", "v1", "v2"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_floods_are_held_to_their_fair_share_of_the_file() {
        let dir = temp_dir("concurrent-fair");
        let base = dir.to_str().unwrap().to_string();
        // The file limit binds here: fair share 6 / 2 = 3.
        let limits = |m: VectorMemory| m.with_max_namespace_rows(5).with_max_total_rows(6);
        let a = Arc::new(limits(VectorMemory::new(&base, 1, "m")));
        let b = Arc::new(limits(VectorMemory::new(&base, 1, "m")));
        for i in 0..3 {
            a.store("victim", "v", &format!("v{i}"), &[0.0])
                .await
                .unwrap();
        }
        let mut tasks = Vec::new();
        for i in 0..64 {
            let m = if i % 2 == 0 {
                Arc::clone(&a)
            } else {
                Arc::clone(&b)
            };
            tasks.push(tokio::spawn(async move {
                m.store("flood", &format!("agent{i}"), &format!("f{i}"), &[0.0])
                    .await
            }));
        }
        for t in tasks {
            t.await.unwrap().unwrap();
        }
        assert_eq!(
            rows_per_namespace(&a),
            vec![("flood".to_string(), 3), ("victim".to_string(), 3)]
        );
        assert_eq!(texts_in(&b, "victim", "v", 1).await, vec!["v0", "v1", "v2"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn memory_error_messages_and_give_up_classification() {
        let deadline: anyhow::Error = MemoryError::SearchDeadline(1000).into();
        assert_eq!(deadline.to_string(), "search did not finish within 1000 ms");
        assert!(MemoryError::is_search_give_up(&deadline));
        // A context layer keeps the typed error reachable.
        let wrapped = deadline.context("searching");
        assert!(MemoryError::is_search_give_up(&wrapped));

        let busy: anyhow::Error = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY),
            None,
        )
        .into();
        assert!(MemoryError::is_search_give_up(&busy));
        let locked: anyhow::Error = rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_LOCKED),
            None,
        )
        .into();
        assert!(MemoryError::is_search_give_up(&locked));

        // Other errors are real failures, not deliberate give-ups.
        assert!(!MemoryError::is_search_give_up(&anyhow!("disk full")));
        let other: anyhow::Error = rusqlite::Error::QueryReturnedNoRows.into();
        assert!(!MemoryError::is_search_give_up(&other));
    }

    #[tokio::test]
    async fn dimension_and_value_errors_name_the_problem() {
        let dir = temp_dir("errmsg");
        let m = VectorMemory::new(dir.to_str().unwrap(), 3, "m");
        let e = m.store(NS, "a", "x", &[1.0, 2.0]).await.unwrap_err();
        assert!(e.to_string().contains("2 dimensions"), "{e}");
        assert!(e.to_string().contains("expects 3"), "{e}");
        let e = m.search(NS, "a", &[], 1).await.unwrap_err();
        assert!(e.to_string().contains("0 dimensions"), "{e}");
        let e = m
            .store(NS, "a", "x", &[0.0, f32::NEG_INFINITY, 0.0])
            .await
            .unwrap_err();
        assert!(e.to_string().contains("NaN or infinite"), "{e}");
        assert!(!gave_up(&e));
        // Rejected input never creates the file.
        assert!(!m.db_path().exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_zero_limit_returns_nothing_and_a_large_one_returns_everything() {
        let dir = temp_dir("limits-k");
        let m = VectorMemory::new(dir.to_str().unwrap(), 2, "m");
        m.store(NS, "a", "one", &[1.0, 0.0]).await.unwrap();
        m.store(NS, "a", "two", &[2.0, 0.0]).await.unwrap();
        assert!(m.search(NS, "a", &[0.0, 0.0], 0).await.unwrap().is_empty());
        // A zero limit still validates the query.
        assert!(m.search(NS, "a", &[0.0], 0).await.is_err());
        let all = m.search(NS, "a", &[0.0, 0.0], usize::MAX).await.unwrap();
        assert_eq!(
            all,
            vec![("one".to_string(), 1.0), ("two".to_string(), 4.0)]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn equal_distances_and_repeated_texts_are_all_kept() {
        let dir = temp_dir("ties");
        let m = VectorMemory::new(dir.to_str().unwrap(), 2, "m");
        m.store(NS, "a", "left", &[-1.0, 0.0]).await.unwrap();
        m.store(NS, "a", "right", &[1.0, 0.0]).await.unwrap();
        m.store(NS, "a", "right", &[1.0, 0.0]).await.unwrap();
        m.store(NS, "a", "far", &[5.0, 0.0]).await.unwrap();
        let r = m.search(NS, "a", &[0.0, 0.0], 3).await.unwrap();
        assert_eq!(r.len(), 3);
        assert!(r.iter().all(|(_, d)| *d == 1.0));
        let r = m.search(NS, "a", &[0.0, 0.0], 4).await.unwrap();
        assert_eq!(r[3], ("far".to_string(), 25.0));
        assert!(r.windows(2).all(|w| w[0].1 <= w[1].1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn rows_of_another_dimension_are_ignored_by_search() {
        let dir = temp_dir("otherdim");
        let m = VectorMemory::new(dir.to_str().unwrap(), 2, "m");
        m.store(NS, "a", "good", &[1.0, 0.0]).await.unwrap();
        let blob: Vec<u8> = [1.0f32, 0.0, 0.0]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        Connection::open(m.db_path())
            .unwrap()
            .execute(
                "INSERT INTO memory (namespace, agent_id, text, vector) VALUES (?1, ?2, ?3, ?4)",
                params![NS, "a", "wrong size", blob],
            )
            .unwrap();
        let r = m.search(NS, "a", &[0.0, 0.0], 5).await.unwrap();
        assert_eq!(r, vec![("good".to_string(), 1.0)]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn stored_rows_survive_reopening_the_file() {
        let dir = temp_dir("reopen");
        {
            let m = VectorMemory::new(dir.to_str().unwrap(), 2, "m");
            m.store(NS, "a", "kept", &[1.0, 1.0]).await.unwrap();
        }
        let m = VectorMemory::new(dir.to_str().unwrap(), 2, "m");
        assert_eq!(texts(&m, "a", 2).await, vec!["kept"]);
        // Another model id uses another file and sees nothing.
        let other = VectorMemory::new(dir.to_str().unwrap(), 2, "other");
        assert!(texts(&other, "a", 2).await.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn input_errors_do_not_reach_the_failure_log() {
        let dir = temp_dir("failcount");
        let m = VectorMemory::new(dir.to_str().unwrap(), 2, "m");
        assert!(m.search(NS, "a", &[1.0], 1).await.is_err());
        // Input errors fail before the log; only database failures count.
        assert_eq!(m.failures.suppressed.load(Ordering::Relaxed), 0);
        assert!(m.failures.last_warning.lock().unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_failure_log_resets_its_count_on_each_warning() {
        let log = FailureLog::new();
        assert_eq!(log.suppressed.load(Ordering::Relaxed), 0);
        let t0 = Instant::now();
        assert_eq!(log.warn_now(t0), Some(0));
        for i in 1..=5u64 {
            assert_eq!(log.warn_now(t0 + Duration::from_secs(i)), None);
        }
        assert_eq!(log.suppressed.load(Ordering::Relaxed), 5);
        assert_eq!(
            log.warn_now(t0 + WARN_INTERVAL + Duration::from_secs(1)),
            Some(5)
        );
        assert_eq!(log.suppressed.load(Ordering::Relaxed), 0);
        // A clock reading before the last warning counts as inside the interval.
        assert_eq!(log.warn_now(t0), None);
    }

    #[test]
    fn reporting_failures_covers_every_branch() {
        let log = FailureLog::new();
        let err = anyhow!("disk full");
        // The first call warns, the next ones go to debug level.
        log.report("store", &err);
        log.report("search", &err);
        log.report("search", &err);
        assert_eq!(log.suppressed.load(Ordering::Relaxed), 2);
        // Make the next failure a warning that carries the earlier count.
        *log.last_warning.lock().unwrap() = Some(Instant::now() - WARN_INTERVAL * 2);
        log.report("store", &err);
        assert_eq!(log.suppressed.load(Ordering::Relaxed), 0);
    }
}
