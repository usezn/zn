//! Model registry (SQLite via rusqlite): versions of models, status and metrics.
//! A row is the unit of promotion/rollback (Phase C-3) and audit (Phase E).

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::path::Path;

#[derive(Debug, Clone)]
pub struct ModelEntry {
    pub id: String,
    pub model_id: String,
    pub version: String,
    pub dim: i64,
    pub path: String,
    pub metrics: String, // JSON (train-time holdout)
    pub status: String,  // staging | active | canary | retired
    pub created_at: i64,
}

pub struct ModelRegistry {
    conn: Connection,
}

impl ModelRegistry {
    pub fn new(path: &str) -> Result<Self> {
        if let Some(parent) = Path::new(path).parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path).context("open model registry")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS models (
                id INTEGER PRIMARY KEY,
                model_id TEXT NOT NULL,
                version TEXT NOT NULL,
                dim INTEGER NOT NULL,
                path TEXT NOT NULL,
                metrics TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'staging',
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_models_status ON models(status);",
        )
        .context("migrate model registry")?;
        Ok(Self { conn })
    }

    /// Inserts and returns the entry with its generated id.
    pub fn register(&self, e: &ModelEntry) -> Result<ModelEntry> {
        let id = {
            let mut stmt = self
                .conn
                .prepare("INSERT INTO models (model_id, version, dim, path, metrics, status, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)")?;
            stmt.execute(params![
                e.model_id,
                e.version,
                e.dim,
                e.path,
                e.metrics,
                e.status,
                e.created_at
            ])?;
            self.conn.last_insert_rowid()
        };
        Ok(ModelEntry {
            id: id.to_string(),
            ..e.clone()
        })
    }

    pub fn get(&self, id: &str) -> Result<Option<ModelEntry>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, model_id, version, dim, path, metrics, status, created_at FROM models WHERE id = ?1")?;
        let mut rows = stmt.query_map(params![id], |r| {
            Ok(ModelEntry {
                id: r.get::<_, i64>(0)?.to_string(),
                model_id: r.get(1)?,
                version: r.get(2)?,
                dim: r.get(3)?,
                path: r.get(4)?,
                metrics: r.get(5)?,
                status: r.get(6)?,
                created_at: r.get(7)?,
            })
        })?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    pub fn entries(&self, status: Option<&str>) -> Result<Vec<ModelEntry>> {
        let q = "SELECT id, model_id, version, dim, path, metrics, status, created_at FROM models";
        let mut out = Vec::new();
        match status {
            Some(s) => {
                let mut stmt = self.conn.prepare(&format!("{q} WHERE status = ?1"))?;
                let rows = stmt.query_map(params![s], row_map)?;
                for r in rows {
                    out.push(r?);
                }
            }
            None => {
                let mut stmt = self.conn.prepare(q)?;
                let rows = stmt.query_map([], row_map)?;
                for r in rows {
                    out.push(r?);
                }
            }
        }
        out.sort_by_key(|e| std::cmp::Reverse(e.created_at));
        Ok(out)
    }

    pub fn set_status(&self, id: &str, status: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE models SET status = ?2 WHERE id = ?1",
            params![id, status],
        )?;
        Ok(())
    }
}

fn row_map(r: &rusqlite::Row) -> rusqlite::Result<ModelEntry> {
    Ok(ModelEntry {
        id: r.get::<_, i64>(0)?.to_string(),
        model_id: r.get(1)?,
        version: r.get(2)?,
        dim: r.get(3)?,
        path: r.get(4)?,
        metrics: r.get(5)?,
        status: r.get(6)?,
        created_at: r.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id_suffix: &str) -> ModelEntry {
        ModelEntry {
            id: String::new(),
            model_id: "zn-minilm".to_string(),
            version: format!("v-{id_suffix}"),
            dim: 384,
            path: format!("/models/{id_suffix}"),
            metrics: "{\"f1\":0.9}".to_string(),
            status: "staging".to_string(),
            created_at: 1_700_000_000 + id_suffix.chars().next().unwrap() as i64,
        }
    }

    #[test]
    fn register_get_and_status_lifecycle() {
        let dir = std::env::temp_dir().join(format!("zn-reg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("models.db").to_string_lossy().to_string();
        let reg = ModelRegistry::new(&db).unwrap();
        let a = reg.register(&entry("a")).unwrap();
        let b = reg.register(&entry("b")).unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(reg.get(&a.id).unwrap().unwrap().model_id, "zn-minilm");
        reg.set_status(&a.id, "canary").unwrap();
        assert_eq!(reg.get(&a.id).unwrap().unwrap().status, "canary");
        reg.set_status(&a.id, "active").unwrap();
        assert_eq!(reg.entries(Some("active")).unwrap().len(), 1);
        assert_eq!(reg.entries(None).unwrap().len(), 2);
        // newest first
        assert_eq!(reg.entries(None).unwrap()[0].id, b.id);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn temp_db(tag: &str) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("zn-reg-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("models.db").to_string_lossy().to_string();
        (dir, db)
    }

    #[test]
    fn get_unknown_or_non_numeric_id_is_none() {
        let (dir, db) = temp_db("get-unknown");
        let reg = ModelRegistry::new(&db).unwrap();
        assert!(reg.get("999").unwrap().is_none());
        assert!(reg.get("not-a-number").unwrap().is_none());
        assert!(reg.get("").unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn register_preserves_every_field_and_assigns_id() {
        let (dir, db) = temp_db("fields");
        let reg = ModelRegistry::new(&db).unwrap();
        let src = entry("a");
        let stored = reg.register(&src).unwrap();
        assert!(!stored.id.is_empty());
        let got = reg.get(&stored.id).unwrap().unwrap();
        assert_eq!(got.id, stored.id);
        assert_eq!(got.model_id, src.model_id);
        assert_eq!(got.version, src.version);
        assert_eq!(got.dim, 384);
        assert_eq!(got.path, src.path);
        assert_eq!(got.metrics, src.metrics);
        assert_eq!(got.status, "staging");
        assert_eq!(got.created_at, src.created_at);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_register_creates_two_distinct_rows() {
        let (dir, db) = temp_db("dup");
        let reg = ModelRegistry::new(&db).unwrap();
        let e = entry("a");
        let first = reg.register(&e).unwrap();
        let second = reg.register(&e).unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(reg.entries(None).unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn entries_filter_by_status() {
        let (dir, db) = temp_db("filter");
        let reg = ModelRegistry::new(&db).unwrap();
        let a = reg.register(&entry("a")).unwrap();
        let b = reg.register(&entry("b")).unwrap();
        let c = reg.register(&entry("c")).unwrap();
        reg.set_status(&a.id, "active").unwrap();
        reg.set_status(&b.id, "canary").unwrap();
        let staging = reg.entries(Some("staging")).unwrap();
        assert_eq!(staging.len(), 1);
        assert_eq!(staging[0].id, c.id);
        assert_eq!(reg.entries(Some("active")).unwrap()[0].id, a.id);
        assert_eq!(reg.entries(Some("canary")).unwrap()[0].id, b.id);
        assert!(reg.entries(Some("retired")).unwrap().is_empty());
        assert!(reg.entries(Some("")).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn entries_are_sorted_newest_first() {
        let (dir, db) = temp_db("order");
        let reg = ModelRegistry::new(&db).unwrap();
        let ids: Vec<String> = ["a", "c", "b"]
            .iter()
            .map(|s| reg.register(&entry(s)).unwrap().id)
            .collect();
        let got: Vec<String> = reg
            .entries(None)
            .unwrap()
            .into_iter()
            .map(|e| e.id)
            .collect();
        // created_at grows with the first letter: c, b, a
        assert_eq!(got, vec![ids[1].clone(), ids[2].clone(), ids[0].clone()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_status_on_unknown_id_is_a_silent_no_op() {
        let (dir, db) = temp_db("unknown-status");
        let reg = ModelRegistry::new(&db).unwrap();
        let a = reg.register(&entry("a")).unwrap();
        // Current behaviour: no error and nothing changes.
        reg.set_status("424242", "active").unwrap();
        reg.set_status("not-a-number", "active").unwrap();
        assert_eq!(reg.get(&a.id).unwrap().unwrap().status, "staging");
        assert_eq!(reg.entries(None).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_status_changes_only_the_target_row() {
        let (dir, db) = temp_db("only-target");
        let reg = ModelRegistry::new(&db).unwrap();
        let a = reg.register(&entry("a")).unwrap();
        let b = reg.register(&entry("b")).unwrap();
        reg.set_status(&a.id, "retired").unwrap();
        assert_eq!(reg.get(&a.id).unwrap().unwrap().status, "retired");
        assert_eq!(reg.get(&b.id).unwrap().unwrap().status, "staging");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reopening_the_database_keeps_entries_and_status() {
        let (dir, db) = temp_db("reopen");
        let (a_id, b_id) = {
            let reg = ModelRegistry::new(&db).unwrap();
            let a = reg.register(&entry("a")).unwrap();
            let b = reg.register(&entry("b")).unwrap();
            reg.set_status(&a.id, "active").unwrap();
            (a.id, b.id)
        };
        let reg = ModelRegistry::new(&db).unwrap();
        assert_eq!(reg.entries(None).unwrap().len(), 2);
        assert_eq!(reg.get(&a_id).unwrap().unwrap().status, "active");
        assert_eq!(reg.get(&b_id).unwrap().unwrap().metrics, "{\"f1\":0.9}");
        // ids keep growing after a reopen, they are not reused
        let c = reg.register(&entry("c")).unwrap();
        assert_ne!(c.id, a_id);
        assert_ne!(c.id, b_id);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_creates_missing_parent_directories() {
        let (dir, _) = temp_db("nested");
        let db = dir.join("a").join("b").join("models.db");
        let reg = ModelRegistry::new(&db.to_string_lossy()).unwrap();
        reg.register(&entry("a")).unwrap();
        assert!(db.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_fails_when_the_path_is_a_directory() {
        let (dir, _) = temp_db("is-dir");
        assert!(ModelRegistry::new(&dir.to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_path_opens_a_private_temporary_database() {
        let reg = ModelRegistry::new("").unwrap();
        let a = reg.register(&entry("a")).unwrap();
        assert_eq!(reg.get(&a.id).unwrap().unwrap().version, "v-a");
    }
}
