//! Finding the program of a stdio MCP server, and checking its arguments, on Windows.
//!
//! On Windows `npx` and `uvx` are usually `.cmd` shims. The standard library only appends
//! `.exe` to a bare name, so `Command::new("npx")` does not find `npx.cmd`. These functions take
//! the PATH, PATHEXT and a file test as inputs, so they run the same way on every platform.

/// The extensions Windows tries when none is given, used when PATHEXT is not set.
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// Characters that `cmd.exe` reads as syntax even inside a batch file's arguments.
const CMD_METACHARACTERS: &[char] = &['&', '|', '<', '>', '^', '%', '(', ')', '"', '\r', '\n', '\0'];

fn has_separator(command: &str) -> bool {
    command.contains('\\') || command.contains('/') || command.contains(':')
}

/// True for a folder that does not depend on the current directory: `C:\x` or `C:/x` (drive and
/// root) or a UNC path `\\server\share`. `.`, `bin`, `C:bin` (relative to the drive's current
/// folder) and `\bin` (root of the current drive) all depend on where the gateway was started.
fn is_absolute_windows(dir: &str) -> bool {
    let b = dir.as_bytes();
    let slash = |c: u8| c == b'\\' || c == b'/';
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && slash(b[2]) {
        return true;
    }
    b.len() >= 3 && slash(b[0]) && slash(b[1]) && !slash(b[2])
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('\\') || dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}\\{name}")
    }
}

/// Find the file Windows would run for `command`, searching `path_var` (`;`-separated) and trying
/// the extensions of `pathext`. Only absolute PATH entries are searched: never the current folder
/// and never a relative entry, so a file with the name of a tool dropped in the folder you started
/// the gateway from is never picked up.
/// `is_file` says whether a candidate exists.
pub fn resolve_windows_command(
    command: &str,
    path_var: Option<&str>,
    pathext: Option<&str>,
    is_file: &dyn Fn(&str) -> bool,
) -> Result<String, String> {
    let exts: Vec<String> = pathext
        .filter(|p| !p.trim().is_empty())
        .unwrap_or(DEFAULT_PATHEXT)
        .split(';')
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty())
        .collect();

    let lower = command.to_lowercase();
    let has_known_ext = exts.iter().any(|e| lower.ends_with(&e.to_lowercase()));

    // The names to try in each folder: as written when it already ends in a known extension,
    // then with each extension added.
    let mut names: Vec<String> = Vec::new();
    if has_known_ext {
        names.push(command.to_string());
    }
    for e in &exts {
        names.push(format!("{command}{e}"));
    }

    if has_separator(command) {
        return names
            .into_iter()
            .find(|n| is_file(n))
            .ok_or_else(|| not_found(command, &exts));
    }

    for dir in path_var.unwrap_or("").split(';') {
        let dir = dir.trim().trim_matches('"');
        // A relative entry (`.`, `node_modules\.bin`, `C:bin`, `\bin`) would be searched from the
        // folder the gateway runs in, which is the user's project, so a project could plant a tool.
        if dir.is_empty() || !is_absolute_windows(dir) {
            continue;
        }
        for n in &names {
            let candidate = join(dir, n);
            if is_file(&candidate) {
                return Ok(candidate);
            }
        }
    }
    Err(not_found(command, &exts))
}

fn not_found(command: &str, exts: &[String]) -> String {
    format!(
        "Could not find the program '{command}' to start the MCP server. It must be installed and in a folder on your PATH (tried the endings {}).",
        exts.join(" ")
    )
}

/// True when the resolved program is a batch file, which Windows runs through `cmd.exe`.
pub fn is_batch_file(program: &str) -> bool {
    let lower = program.to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

/// A batch file's arguments pass through `cmd.exe`, which acts on `& | < > ^ % ( )` whatever the
/// quoting. Quoting cannot make every value safe, so the gateway refuses these arguments instead
/// of guessing. Spaces are fine: they are quoted. A server that needs such an argument can be
/// started with a program that is not a batch file (for example `node` with the script path).
pub fn check_batch_args(program: &str, args: &[String]) -> Result<(), String> {
    for arg in args {
        if let Some(c) = arg.chars().find(|c| CMD_METACHARACTERS.contains(c)) {
            let shown = match c {
                '\r' | '\n' => "a line break".to_string(),
                '\0' => "a null character".to_string(),
                other => format!("'{other}'"),
            };
            return Err(format!(
                "The MCP server argument '{}' has {shown}, which Windows cmd.exe would read as a command. \
                 '{program}' is a .cmd or .bat file that runs through cmd.exe, so zn will not start it with this argument. \
                 Remove the character, or start the server with a program that is not a .cmd or .bat file.",
                arg.escape_debug()
            ));
        }
    }
    Ok(())
}

/// Resolve `command` the way Windows does, from the real PATH and PATHEXT.
#[cfg(windows)]
pub fn resolve_for_spawn(command: &str) -> Result<String, String> {
    use std::path::Path;
    let path_var = std::env::var("PATH").ok();
    let pathext = std::env::var("PATHEXT").ok();
    resolve_windows_command(command, path_var.as_deref(), pathext.as_deref(), &|p| {
        Path::new(p).is_file()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files<'a>(list: &'a [&'a str]) -> impl Fn(&str) -> bool + 'a {
        move |p| list.contains(&p)
    }

    #[test]
    fn a_bare_name_resolves_to_the_cmd_shim_on_path() {
        let f = files(&["C:\\Program Files\\nodejs\\npx.CMD"]);
        let got = resolve_windows_command(
            "npx",
            Some("C:\\Windows;C:\\Program Files\\nodejs\\"),
            Some(".COM;.EXE;.BAT;.CMD"),
            &f,
        );
        assert_eq!(got.unwrap(), "C:\\Program Files\\nodejs\\npx.CMD");
    }

    #[test]
    fn extension_order_and_path_order_decide() {
        let f = files(&["C:\\a\\uvx.CMD", "C:\\b\\uvx.EXE"]);
        // The first folder wins even if a later one has a better extension.
        let got = resolve_windows_command("uvx", Some("C:\\a;C:\\b"), None, &f).unwrap();
        assert_eq!(got, "C:\\a\\uvx.CMD");
        // In one folder, the order of PATHEXT decides.
        let f = files(&["C:\\a\\uvx.CMD", "C:\\a\\uvx.EXE"]);
        let got = resolve_windows_command("uvx", Some("C:\\a"), None, &f).unwrap();
        assert_eq!(got, "C:\\a\\uvx.EXE");
    }

    #[test]
    fn a_name_that_already_has_an_extension_is_used_as_written() {
        let f = files(&["C:\\t\\npx.CMD"]);
        let got = resolve_windows_command("npx.CMD", Some("C:\\t"), None, &f).unwrap();
        assert_eq!(got, "C:\\t\\npx.CMD");
    }

    #[test]
    fn a_path_with_a_folder_is_not_searched_on_path() {
        let f = files(&["D:\\tools\\node.EXE", "C:\\bin\\D:\\tools\\node.EXE"]);
        let got = resolve_windows_command("D:\\tools\\node", Some("C:\\bin"), None, &f).unwrap();
        assert_eq!(got, "D:\\tools\\node.EXE");
    }

    #[test]
    fn the_current_folder_is_never_searched() {
        // A "npx.cmd" in the working folder must not be found when PATH has none.
        let f = files(&["npx.cmd", ".\\npx.cmd"]);
        assert!(resolve_windows_command("npx", Some("C:\\bin"), None, &f).is_err());
        assert!(resolve_windows_command("npx", Some(""), None, &f).is_err());
        assert!(resolve_windows_command("npx", None, None, &f).is_err());
    }

    #[test]
    fn relative_path_entries_are_never_searched() {
        let f = files(&[
            "npx.CMD",
            ".\\npx.CMD",
            "node_modules\\.bin\\npx.CMD",
            "C:bin\\npx.CMD",
            "\\bin\\npx.CMD",
            "bin\\npx.CMD",
        ]);
        let path = ".;node_modules\\.bin;C:bin;\\bin;bin;\"C:bin\"";
        assert!(resolve_windows_command("npx", Some(path), None, &f).is_err());
        // An absolute entry later in PATH still works.
        let f = files(&["C:bin\\npx.CMD", "C:\\good\\npx.CMD"]);
        let path = "C:bin;C:\\good";
        assert_eq!(
            resolve_windows_command("npx", Some(path), None, &f).unwrap(),
            "C:\\good\\npx.CMD"
        );
    }

    #[test]
    fn absolute_entries_are_recognised() {
        for ok in [
            "C:\\bin",
            "c:/bin",
            "D:\\",
            "\\\\server\\share\\bin",
            "\\\\?\\C:\\bin",
        ] {
            assert!(is_absolute_windows(ok), "{ok}");
        }
        for bad in [
            "", ".", "..", "bin", "C:", "C:bin", "\\bin", "/bin", "\\\\", "\\\\\\x",
        ] {
            assert!(!is_absolute_windows(bad), "{bad}");
        }
    }

    #[test]
    fn a_folder_with_spaces_resolves_and_keeps_its_spaces() {
        let f = files(&["C:\\Program Files\\nodejs\\npx.CMD"]);
        let got =
            resolve_windows_command("npx", Some("C:\\Program Files\\nodejs"), None, &f).unwrap();
        assert_eq!(got, "C:\\Program Files\\nodejs\\npx.CMD");
        assert!(is_batch_file(&got));
        assert!(check_batch_args(&got, &["-y".to_string(), "a b".to_string()]).is_ok());
    }

    // The standard library runs a .cmd through cmd.exe and quotes the program path itself, so a
    // folder with a space must start and pass its arguments through.
    #[cfg(windows)]
    #[test]
    fn a_cmd_file_in_a_folder_with_spaces_starts() {
        let dir = std::env::temp_dir().join(format!("zn cmd test {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("tool.cmd"), "@echo off\r\necho got %1 %2\r\n").unwrap();
        let program =
            resolve_windows_command("tool", Some(dir.to_str().unwrap()), Some(".CMD"), &|p| {
                std::path::Path::new(p).is_file()
            })
            .unwrap();
        let out = std::process::Command::new(&program)
            .args(["one", "two"])
            .output()
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("got one two"));
    }

    #[test]
    fn a_missing_program_names_the_command() {
        let f = files(&[]);
        let err =
            resolve_windows_command("uvx", Some("C:\\bin"), Some(".EXE;.CMD"), &f).unwrap_err();
        assert!(
            err.contains("'uvx'") && err.contains("PATH") && err.contains(".CMD"),
            "{err}"
        );
    }

    #[test]
    fn quoted_path_entries_and_blank_pathext_are_handled() {
        let f = files(&["C:\\My Tools\\node.EXE"]);
        let got =
            resolve_windows_command("node", Some("\"C:\\My Tools\";;"), Some("  "), &f).unwrap();
        assert_eq!(got, "C:\\My Tools\\node.EXE");
    }

    #[test]
    fn batch_files_are_recognised_by_extension() {
        assert!(is_batch_file("C:\\x\\npx.cmd"));
        assert!(is_batch_file("run.BAT"));
        assert!(!is_batch_file("node.exe"));
        assert!(!is_batch_file("cmd"));
    }

    #[test]
    fn spaces_and_ordinary_characters_are_allowed_in_batch_arguments() {
        let args = vec![
            "-y".to_string(),
            "@scope/server@1.2.3".to_string(),
            "C:\\Users\\Example User\\notes".to_string(),
            "--flag=a b".to_string(),
        ];
        assert!(check_batch_args("npx.cmd", &args).is_ok());
    }

    #[test]
    fn cmd_metacharacters_are_refused_with_a_clear_message() {
        for bad in [
            "a&b",
            "a|b",
            "a<b",
            "a>b",
            "a^b",
            "%PATH%",
            "a(b",
            "a)b",
            "say \"hi\"",
            "a\nb",
        ] {
            let err = check_batch_args("npx.cmd", &[bad.to_string()]).unwrap_err();
            assert!(
                err.contains("cmd.exe") && err.contains("npx.cmd"),
                "{bad}: {err}"
            );
        }
    }
}
