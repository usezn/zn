//! zn-hook-exec: the first process an agent host starts for a zn-gate hook.
//!
//! Usage: zn-hook-exec <mode> -- <program> [args...]
//!
//! Why it exists: with LD_TRACE_LOADED_OBJECTS or LD_DEBUG=help in the environment, ld.so ends every dynamic program
//! (sh, env, node) with status 0 and no output before its first line runs, which a host reads as "allow". This binary is
//! linked statically on Linux (musl), so ld.so is never involved: it removes the loader variables, then execs the program
//! (the sh hook launcher) with a clean environment. If it cannot exec, it answers with the host's deny instead of exiting
//! silently. Any wrong usage is a deny as well.
//!
//! <mode> is how the host reads a block:
//!   exit2        exit status 2 and the reason on stderr (Claude Code, Gemini CLI, Codex PreToolUse/UserPromptSubmit, Cursor)
//!   permission   Codex PermissionRequest: deny decision as JSON on stdout, status 0
//!   decision     {"decision":"deny","reason":...} on stdout, status 0 (Antigravity)
//!   warn         only a systemMessage on stdout, status 0 (events that cannot block)
//!   warn-stderr  only a warning on stderr, status 0 (Cursor events that cannot block)

mod names;

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::process::{exit, Command};

const REASON: &str = "zn: its hook was blocked because the hook launcher could not be started (zn-hook-exec failed). Ask the user to run `zn hooks install` again in their terminal, or `zn-gate check` to see why.";
const WARNING: &str = "zn is NOT protecting this session: the hook launcher could not be started (zn-hook-exec failed). Please run `zn hooks install` again in your own terminal, or `zn-gate check` to see why.";

fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// Answers the way the host reads a block, then ends. Never returns.
fn answer(mode: &str) -> ! {
    match mode {
        "permission" => println!(
            "{{\"hookSpecificOutput\":{{\"hookEventName\":\"PermissionRequest\",\"decision\":{{\"behavior\":\"deny\",\"message\":{}}}}}}}",
            json_str(REASON)
        ),
        "decision" => println!("{{\"decision\":\"deny\",\"reason\":{}}}", json_str(REASON)),
        "warn" => println!("{{\"systemMessage\":{}}}", json_str(WARNING)),
        "warn-stderr" => eprintln!("{WARNING}"),
        // exit2, and any mode this build does not know: block.
        _ => {
            eprintln!("{REASON}");
            exit(2);
        }
    }
    exit(0);
}

#[cfg(unix)]
fn main() {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let mode = args.first().and_then(|m| m.to_str()).unwrap_or("exit2").to_string();
    // Layout: <mode> -- <program> [args...]
    if args.len() < 3 || args[1] != "--" {
        answer(&mode);
    }
    let mut cmd = Command::new(&args[2]);
    cmd.args(&args[3..]);
    let mut removed: Vec<String> = Vec::new();
    for (k, _) in std::env::vars_os() {
        if names::is_loader_name(k.as_bytes()) {
            cmd.env_remove(&k);
            removed.push(String::from_utf8_lossy(k.as_bytes()).into_owned());
        }
    }
    if !removed.is_empty() {
        // Names only, never values: lets the hook launcher and `zn-gate check` say that the environment was cleaned.
        removed.sort();
        cmd.env("ZN_LOADER_SCRUBBED", removed.join(","));
    }
    // exec only returns on failure.
    let _err = cmd.exec();
    answer(&mode);
}

#[cfg(not(unix))]
fn main() {
    // Windows has no ld.so: the PowerShell command of the hook is used there, not this binary.
    eprintln!("zn-hook-exec is for Linux and macOS only");
    exit(2);
}
