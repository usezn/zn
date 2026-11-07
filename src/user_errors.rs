//! Plain-English wording for start-up problems: what happened, which folder or
//! file, and what to do. The functions only build text, so they are tested
//! without touching the file system.

use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

/// A path for people: relative paths are made absolute and `./` is dropped.
pub fn display_path(path: &Path) -> String {
    let full = if path.is_absolute() {
        path.to_path_buf()
    } else {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(path),
            Err(_) => path.to_path_buf(),
        }
    };
    let clean: PathBuf = full
        .components()
        .filter(|c| !matches!(c, Component::CurDir))
        .collect();
    clean.display().to_string()
}

/// The text of an error without the operating system code and without the
/// list of paths some libraries append, for example
/// `Permission denied (os error 13)` becomes `Permission denied`.
pub fn plain_text(raw: &str) -> String {
    let cut = raw.split(" about [").next().unwrap_or(raw);
    match cut.rfind(" (os error ") {
        Some(i) => cut[..i].to_string(),
        None => cut.to_string(),
    }
}

/// Short reason for the common kinds of file system error.
pub fn io_reason(kind: ErrorKind) -> Option<&'static str> {
    match kind {
        ErrorKind::PermissionDenied => {
            Some("permission denied, this user is not allowed to write there")
        }
        ErrorKind::NotFound => Some("a folder on the way to it does not exist"),
        ErrorKind::ReadOnlyFilesystem => Some("the disk is read-only"),
        _ => None,
    }
}

/// The first file system error kind found in an error and its causes.
pub fn io_kind(err: &anyhow::Error) -> Option<ErrorKind> {
    err.chain()
        .find_map(|e| e.downcast_ref::<std::io::Error>().map(|io| io.kind()))
}

fn reason_of(err: &anyhow::Error) -> String {
    match io_kind(err).and_then(io_reason) {
        Some(r) => r.to_string(),
        None => plain_text(&format!("{err:#}")),
    }
}

/// The policy folder could not be read or created.
pub fn policy_folder_problem(dir: &str, err: &anyhow::Error) -> String {
    format!(
        "zn could not prepare its policy folder {}: {}. zn keeps its security policy files there. Run zn from a folder you own, or set \"engine.policy_dir\" in zn.json to a folder you can write to.",
        display_path(Path::new(dir)),
        reason_of(err)
    )
}

/// The policy folder cannot be watched for changes. `load_err` is the earlier
/// failure to read or create it, if there was one.
pub fn policy_watch_problem(
    dir: &str,
    exists: bool,
    load_err: Option<&anyhow::Error>,
    watch_err: &anyhow::Error,
) -> String {
    let shown = display_path(Path::new(dir));
    if exists {
        format!(
            "zn could not watch its policy folder {shown} for changes: {}. Check that this user can read the folder, or set \"engine.policy_dir\" in zn.json to a different folder.",
            reason_of(watch_err)
        )
    } else {
        let why = match load_err {
            Some(e) => reason_of(e),
            None => "the folder does not exist".to_string(),
        };
        format!(
            "zn cannot start: its policy folder {shown} does not exist and could not be created ({why}). Run zn from a folder you own, or set \"engine.policy_dir\" in zn.json to a folder you can write to."
        )
    }
}

/// The data folder (where zn keeps its private reference key) is not usable.
pub fn data_folder_problem(dir: &Path, err: &std::io::Error) -> String {
    let reason = match io_reason(err.kind()) {
        Some(r) => r.to_string(),
        None => plain_text(&err.to_string()),
    };
    format!(
        "zn cannot write to its data folder {}: {}. zn keeps a private key file (ref.key) there. Run zn from a folder you own, or fix the permissions of that folder.",
        display_path(dir),
        reason
    )
}

/// The audit database could not be opened or written. `raw` is the message of
/// the database library and `probe` is what the file system says about the file.
pub fn audit_db_problem(db_path: &str, raw: &str, probe: Option<ErrorKind>) -> String {
    let shown = display_path(Path::new(db_path));
    let parent = Path::new(&shown)
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| shown.clone());
    if raw.contains("readonly database") {
        return format!(
            "zn cannot write to its audit database {shown}: the file is read-only. Make the file writable, or choose another file with --db-path (or \"audit.db_path\" in zn.json)."
        );
    }
    match probe {
        Some(ErrorKind::PermissionDenied) | Some(ErrorKind::ReadOnlyFilesystem) => format!(
            "zn cannot open its audit database {shown}: permission denied. Neither the folder {parent} nor the file can be written by this user. Make them writable, or choose another place with --db-path (or \"audit.db_path\" in zn.json)."
        ),
        Some(ErrorKind::NotFound) => format!(
            "zn cannot create its audit database {shown}: the folder {parent} does not exist. Create the folder, or choose another place with --db-path (or \"audit.db_path\" in zn.json)."
        ),
        _ => format!(
            "zn could not open its audit database {shown}: {}. Choose another place with --db-path (or \"audit.db_path\" in zn.json), and check that no other program has the file open.",
            plain_text(raw)
        ),
    }
}

/// An explicit `--config` file that is not there.
pub fn config_missing(file: &str) -> String {
    format!(
        "the settings file {file} does not exist. Check the path, or create a settings file with: zn init"
    )
}

/// An explicit `--config` file that is not JSON.
pub fn config_not_json(file: &str) -> String {
    format!(
        "the settings file {file} is not a JSON file. zn reads JSON only, so the name must end in .json (for example zn.json). Create one with: zn init"
    )
}

/// A setting in the settings file that zn does not know and ignored.
pub fn unknown_setting(file: &str, setting: &str, suggestion: Option<&str>) -> String {
    match suggestion {
        Some(s) => format!(
            "{file}: unknown setting \"{setting}\" was ignored, did you mean \"{s}\"?"
        ),
        None => format!(
            "{file}: unknown setting \"{setting}\" was ignored. The settings file that `zn init` writes lists every setting zn knows."
        ),
    }
}

/// A misspelt key under `security` or `audit`: zn stops instead of running with a weaker setting.
pub fn unknown_security_setting(file: &str, setting: &str, suggestion: Option<&str>) -> String {
    let hint = match suggestion {
        Some(s) => format!("did you mean \"{s}\"?"),
        None => "the settings file that `zn init` writes lists every setting zn knows.".to_string(),
    };
    format!(
        "{file}: unknown setting \"{setting}\". Settings in the security and audit sections are not ignored, because a typo would silently weaken them, so zn did not start; {hint}"
    )
}

/// `ZN_PORT` is not a port number, so the port from the settings is kept.
pub fn invalid_port_env(value: &str, fallback: u16) -> String {
    format!(
        "ZN_PORT=\"{value}\" is not a valid port number (0-65535), so it was ignored. zn uses port {fallback} instead."
    )
}

/// An upstream MCP server whose command is not on the allowed list.
pub fn mcp_command_not_allowed(
    server: &str,
    command: &str,
    allowed: &[&str],
    file: Option<&str>,
) -> String {
    let place = file
        .map(|f| format!(" in {f}"))
        .unwrap_or_else(|| " in your MCP servers file".to_string());
    format!(
        "MCP server \"{server}\" was skipped: \"{command}\" is not an allowed command. zn only starts: {}. Point the server at one of those{place} (for example \"command\": \"npx\").",
        allowed.join(", ")
    )
}

/// An upstream MCP server with neither a command nor a URL.
pub fn mcp_server_incomplete(server: &str, file: Option<&str>) -> String {
    let place = file.map(|f| format!(" in {f}")).unwrap_or_default();
    format!(
        "MCP server \"{server}\" was skipped: it has neither a \"command\" nor a \"url\"{place}."
    )
}

/// The MCP servers file exists but cannot be used.
pub fn mcp_file_unreadable(file: &str, reason: &str) -> String {
    format!(
        "zn could not read the MCP servers file {file}: {reason}. No MCP servers are loaded from it until it is fixed."
    )
}

/// A WebSocket MCP server did not answer.
pub fn mcp_not_reached(server: &str, url: &str, attempts: u32, reason: &str) -> String {
    format!(
        "zn could not reach MCP server \"{server}\" at {url} after {attempts} attempts ({reason}). Check that the server is running and that the url in your MCP servers file is right."
    )
}

/// A stdio MCP server could not be started.
pub fn mcp_not_started(server: &str, command: &str, reason: &str) -> String {
    format!(
        "zn could not start MCP server \"{server}\" (command \"{command}\"): {}. Check that the command is installed and on your PATH.",
        plain_text(reason)
    )
}

/// What `zn start` does with the upstream servers it found.
pub fn mcp_not_forwarded(count: usize) -> String {
    format!(
        "{count} upstream MCP server(s) found in your MCP servers file, but `zn start` does not forward calls to them. It checks each tool call it reads on stdin and writes the checked message to stdout."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::anyhow;

    fn io(kind: ErrorKind) -> anyhow::Error {
        anyhow::Error::new(std::io::Error::from(kind))
    }

    #[test]
    fn os_codes_and_watcher_paths_are_removed() {
        assert_eq!(
            plain_text("Permission denied (os error 13)"),
            "Permission denied"
        );
        assert_eq!(
            plain_text("No such file or directory (os error 2) about [\"/x/policies_bin\"]"),
            "No such file or directory"
        );
    }

    #[test]
    fn relative_paths_lose_the_dot() {
        let shown = display_path(Path::new("./policies_bin"));
        assert!(
            !shown.contains("/./") && !shown.contains("\\.\\"),
            "{shown}"
        );
        assert!(shown.ends_with("policies_bin"));
    }

    #[test]
    fn policy_folder_message_names_the_folder_and_the_fix() {
        let msg = policy_folder_problem("/srv/zn/policies_bin", &io(ErrorKind::PermissionDenied));
        assert!(msg.contains("/srv/zn/policies_bin"));
        assert!(msg.contains("permission denied"));
        assert!(msg.contains("engine.policy_dir"));
        assert!(!msg.contains("os error"));
    }

    #[test]
    fn missing_folder_is_not_blamed_on_a_missing_file() {
        let load = io(ErrorKind::PermissionDenied);
        let watch =
            anyhow!("No such file or directory (os error 2) about [\"/srv/zn/policies_bin\"]");
        let msg = policy_watch_problem("/srv/zn/policies_bin", false, Some(&load), &watch);
        assert!(msg.contains("could not be created"));
        assert!(msg.contains("permission denied"));
        assert!(!msg.contains("No such file"));
        assert!(!msg.contains("about ["));
    }

    #[test]
    fn watch_failure_on_an_existing_folder_has_no_debug_list() {
        let watch = anyhow!("Too many open files (os error 24) about [\"/srv/zn/policies_bin\"]");
        let msg = policy_watch_problem("/srv/zn/policies_bin", true, None, &watch);
        assert!(msg.contains("Too many open files"));
        assert!(!msg.contains('['));
    }

    #[test]
    fn data_folder_message_says_what_is_kept_there() {
        let e = std::io::Error::from(ErrorKind::PermissionDenied);
        let msg = data_folder_problem(Path::new("/srv/zn/data"), &e);
        assert!(msg.contains("/srv/zn/data"));
        assert!(msg.contains("ref.key"));
        assert!(msg.contains("permission denied"));
    }

    #[test]
    fn audit_database_messages() {
        let ro = audit_db_problem("/d/zn.db", "attempt to write a readonly database", None);
        assert!(ro.contains("/d/zn.db") && ro.contains("read-only") && ro.contains("--db-path"));
        let denied = audit_db_problem(
            "/d/zn.db",
            "unable to open database file",
            Some(ErrorKind::PermissionDenied),
        );
        assert!(denied.contains("permission denied") && denied.contains("/d"));
        let missing = audit_db_problem(
            "/d/zn.db",
            "unable to open database file",
            Some(ErrorKind::NotFound),
        );
        assert!(missing.contains("does not exist"));
    }

    #[test]
    fn settings_file_messages_say_what_to_do() {
        assert!(config_missing("/w/nope.json").contains("does not exist"));
        assert!(config_missing("/w/nope.json").contains("zn init"));
        assert!(config_not_json("/w/zn.toml").contains("not a JSON file"));
        let u = unknown_setting("zn.json", "server.prot", Some("server.port"));
        assert!(u.contains("\"server.prot\" was ignored") && u.contains("\"server.port\""));
        let p = invalid_port_env("abc", 9090);
        assert!(p.contains("\"abc\"") && p.contains("9090"));
    }

    #[test]
    fn mcp_messages_name_the_server_the_command_and_the_list() {
        let m = mcp_command_not_allowed(
            "demo",
            "/x/srv",
            &["node", "npx"],
            Some("/h/mcp_servers.json"),
        );
        assert!(m.contains("\"demo\"") && m.contains("/x/srv") && m.contains("node, npx"));
        assert!(m.contains("/h/mcp_servers.json"));
        assert!(!m.contains('['));
        assert!(mcp_file_unreadable("/h/m.json", "the file ends too early").contains("/h/m.json"));
        assert!(mcp_not_reached("a", "ws://192.0.2.1:1", 5, "refused").contains("ws://192.0.2.1:1"));
        assert!(
            mcp_not_started("a", "node", "No such file or directory (os error 2)")
                .contains("No such file or directory.")
        );
        assert!(mcp_not_forwarded(2).contains("does not forward"));
    }
}
