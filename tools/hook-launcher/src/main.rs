//! zn-hook-launcher: the first program of zn's hook on Linux, for the agents that start a hook program directly,
//! with no shell: Claude Code (`args`) and ZCode (`process`). It also has the answers of GitHub Copilot CLI and
//! Antigravity, but zn does not install it for them yet (both stay detection only, see lib/agents/static-launcher.js).
//!
//! Every dynamically linked program (sh, bash, node) goes through the dynamic loader before its first line, and the
//! loader reads variables from the environment the agent passes on: LD_TRACE_LOADED_OBJECTS (any value) and LD_DEBUG
//! naming `help` make it print text and exit 0 before main(), so a hook started that way never runs and an agent that
//! reads exit 0 as "no objection" lets the call go ahead. LD_PRELOAD and the like load code into the hook.
//!
//! This program is linked statically (musl), so no loader reads those variables before it runs. It then:
//!  1. refuses, with the deny of the agent and its blocking exit code, when one of the variables that stop or load
//!     code into a dynamic program is set (the hook is not started);
//!  2. otherwise removes every loader variable from the environment and replaces itself (exec) with the hook
//!     program, with the same arguments and stdin, so the hook runs as before;
//!  3. fails closed: an error before the hook starts (bad arguments, a program that cannot be started) is a deny.
//!
//! Usage: zn-hook-launcher <agent> <event> <program> [arguments...]
//! It reads no file, writes no file and opens no network connection.

use std::ffi::{OsStr, OsString};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;

/// Names that start a loader variable, in any case (packages/zn-gate/lib/loader-env.js LOADER_PREFIXES).
const LOADER_PREFIXES: &[&str] = &["LD_", "DYLD_"];

/// Other variables that make a program or its interpreter load code (loader-env.js LOADER_NAMES), in any case.
const LOADER_NAMES: &[&str] = &[
    "GCONV_PATH", "GLIBC_TUNABLES", "LOCPATH", "NLSPATH", "HOSTALIASES", "RES_OPTIONS", "OPENSSL_CONF",
    "NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE", "NODE_V8_COVERAGE",
    "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT", "PYTHONUSERBASE", "PERL5OPT", "PERL5LIB", "PERLLIB",
    "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "BASH_ENV", "ENV",
];

/// The variables that load a library into a program or end it before its first line (loader-env.js LOADER_PRELOAD).
/// With a value that is not empty, the launcher refuses, as the sh launcher does.
const LOADER_PRELOAD: &[&str] = &[
    "LD_PRELOAD", "LD_AUDIT", "LD_PROFILE", "LD_LIBMAP", "LD_32_PRELOAD",
    "LD_TRACE_LOADED_OBJECTS", "LD_TRACE_LOADED_OBJECTS_FMT1", "LD_TRACE_LOADED_OBJECTS_FMT2", "LD_TRACE_LOADED_OBJECTS_ALL", "LD_DEBUG", "LD_DEBUG_OUTPUT",
    "LD_PRELOAD_FDS", "LD_LIBMAP_DISABLE", "LD_LOADFLTR",
    "DYLD_INSERT_LIBRARIES", "DYLD_IMAGE_SUFFIX", "DYLD_SHARED_CACHE_DIR", "DYLD_SHARED_REGION",
];

/// glibc's loader traces with LD_TRACE_LOADED_OBJECTS set to any value, the empty string included.
const STOPS_WHEN_EMPTY: &[&str] = &["LD_TRACE_LOADED_OBJECTS"];

// The texts of packages/zn-gate/lib/agents/launcher.js (loaderText, loaderWarnText, crashText, crashWarnText).
const LOADER_TEXT: &str = "zn: its hook was blocked because the environment of the agent sets a loader variable (LD_PRELOAD, LD_AUDIT, DYLD_INSERT_LIBRARIES and the like) that loads code into the hook before it can start. Ask the user to unset it and restart the agent.";
const LOADER_WARN_TEXT: &str = "zn is NOT protecting this session: the environment of the agent sets a loader variable (LD_PRELOAD, LD_AUDIT, DYLD_INSERT_LIBRARIES and the like) that loads code into the hook before it can start. Please unset it and restart the agent.";
const CRASH_TEXT: &str = "zn: its hook failed, so this was blocked. Ask the user to run `zn-gate check` in their terminal to see why.";
const CRASH_WARN_TEXT: &str = "zn is NOT protecting this session: its hook failed. Please run `zn-gate check` in your own terminal to see why.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Agent {
    ClaudeCode,
    Copilot,
    ZCode,
    Antigravity,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Why {
    Loader,
    Crash,
}

#[derive(Debug, PartialEq, Eq)]
struct Answer {
    stdout: Option<String>,
    stderr: Option<String>,
    code: i32,
}

fn agent_of(name: &OsStr) -> Agent {
    match name.as_bytes() {
        b"claude-code" => Agent::ClaudeCode,
        b"copilot" => Agent::Copilot,
        b"zcode" => Agent::ZCode,
        b"antigravity" => Agent::Antigravity,
        _ => Agent::Unknown,
    }
}

fn starts_with_ignore_case(name: &[u8], prefix: &str) -> bool {
    name.len() >= prefix.len() && name[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

/// True for a loader variable: every LD_* and DYLD_* name and the names of LOADER_NAMES, in any case.
fn is_loader_var(name: &[u8]) -> bool {
    LOADER_PREFIXES.iter().any(|p| starts_with_ignore_case(name, p)) || LOADER_NAMES.iter().any(|n| name.eq_ignore_ascii_case(n.as_bytes()))
}

/// True when the environment holds a variable that stops a dynamic program before its first line or loads code into it.
/// The loader reads the names in this exact case only.
fn stops_hook(env: &[(OsString, OsString)]) -> bool {
    env.iter().any(|(k, v)| {
        let k = k.as_bytes();
        STOPS_WHEN_EMPTY.iter().any(|n| k == n.as_bytes()) || (!v.is_empty() && LOADER_PRELOAD.iter().any(|n| k == n.as_bytes()))
    })
}

/// The environment the hook gets: everything but the loader variables, in the same order.
fn clean_env(env: &[(OsString, OsString)]) -> Vec<(OsString, OsString)> {
    env.iter().filter(|(k, _)| !is_loader_var(k.as_bytes())).cloned().collect()
}

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The answer when the hook is not run: the agent's own block on an event that can block, a warning on the others.
/// The same answers as the sh launcher (launcher.js unixScript) and, for Copilot, the project guard (projectAnswer).
fn answer(agent: Agent, event: &str, why: Why) -> Answer {
    let (block_text, warn_text) = match why {
        Why::Loader => (LOADER_TEXT, LOADER_WARN_TEXT),
        Why::Crash => (CRASH_TEXT, CRASH_WARN_TEXT),
    };
    let block_events: &[&str] = match agent {
        Agent::ClaudeCode => &["PreToolUse", "UserPromptSubmit", "UserPromptExpansion"],
        Agent::ZCode => &["PreToolUse", "PermissionRequest", "UserPromptSubmit"],
        Agent::Antigravity => &["PreToolUse"],
        Agent::Copilot => &["preToolUse"],
        Agent::Unknown => &[],
    };
    let line = |s: String| Some(s + "\n");
    if agent == Agent::Unknown {
        // Not one of the agents zn writes this program for: the most common block (exit 2 with the reason on stderr).
        return Answer { stdout: None, stderr: line(block_text.to_string()), code: 2 };
    }
    if block_events.contains(&event) {
        return match agent {
            // Antigravity reads a deny from stdout with exit 0.
            Agent::Antigravity => Answer { stdout: line(format!("{{\"decision\":\"deny\",\"reason\":{}}}", json_string(block_text))), stderr: None, code: 0 },
            // Copilot CLI: exit 2 denies preToolUse even when the JSON says otherwise; the JSON carries the reason.
            Agent::Copilot => Answer {
                stdout: line(format!("{{\"permissionDecision\":\"deny\",\"permissionDecisionReason\":{}}}", json_string(block_text))),
                stderr: line(block_text.to_string()),
                code: 2,
            },
            _ => Answer { stdout: None, stderr: line(block_text.to_string()), code: 2 },
        };
    }
    match agent {
        Agent::Copilot => Answer { stdout: None, stderr: line(warn_text.to_string()), code: 0 },
        _ => Answer { stdout: line(format!("{{\"systemMessage\":{}}}", json_string(warn_text))), stderr: None, code: 0 },
    }
}

fn respond(agent: Agent, event: &str, why: Why) -> ! {
    let a = answer(agent, event, why);
    let mut ok = true;
    if let Some(s) = &a.stdout {
        let mut out = std::io::stdout().lock();
        ok &= out.write_all(s.as_bytes()).and_then(|_| out.flush()).is_ok();
    }
    if let Some(s) = &a.stderr {
        let mut err = std::io::stderr().lock();
        ok &= err.write_all(s.as_bytes()).and_then(|_| err.flush()).is_ok();
    }
    // An answer that could not be written is a failure, never a silent success.
    std::process::exit(if ok { a.code } else { 2 });
}

/// The event as text when it is a plain name (letters only), else "" (an event that cannot block).
fn event_of(arg: Option<&OsString>) -> &str {
    match arg.and_then(|a| a.to_str()) {
        Some(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphabetic()) => s,
        _ => "",
    }
}

fn main() {
    let args: Vec<OsString> = std::env::args_os().collect();
    let env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    let agent = args.get(1).map(|a| agent_of(a)).unwrap_or(Agent::Unknown);
    let event = event_of(args.get(2));
    if stops_hook(&env) {
        respond(agent, event, Why::Loader);
    }
    let program = match args.get(3) {
        Some(p) if agent != Agent::Unknown && Path::new(p).is_absolute() => p,
        _ => respond(agent, event, Why::Crash),
    };
    let err = Command::new(program).args(&args[4..]).env_clear().envs(clean_env(&env)).exec();
    // exec returns only when the program could not be started.
    drop(err);
    respond(agent, event, Why::Crash);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }

    #[test]
    fn loader_variables_in_any_case() {
        for n in ["LD_PRELOAD", "ld_preload", "LD_TRACE_LOADED_OBJECTS", "LD_DEBUG", "LD_SHOW_AUXV", "LD_ANYTHING", "Ld_x", "DYLD_INSERT_LIBRARIES", "dyld_x", "NODE_OPTIONS", "node_options", "GLIBC_TUNABLES", "BASH_ENV", "ENV", "OPENSSL_CONF", "PYTHONUSERBASE", "pythonuserbase"] {
            assert!(is_loader_var(n.as_bytes()), "{n}");
        }
        for n in ["PATH", "HOME", "LD", "LDX_FOO", "ENVIRONMENT", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "SSL_CERT_FILE", "ZN_HOOK_ACK", "XLD_PRELOAD"] {
            assert!(!is_loader_var(n.as_bytes()), "{n}");
        }
    }

    #[test]
    fn stopping_and_preload_variables_refuse() {
        for (k, v) in [("LD_TRACE_LOADED_OBJECTS", "1"), ("LD_TRACE_LOADED_OBJECTS", "0"), ("LD_TRACE_LOADED_OBJECTS", ""), ("LD_DEBUG", "help"), ("LD_DEBUG", "libs,help"), ("LD_DEBUG", "all"), ("LD_PRELOAD", "/example/x.so"), ("LD_AUDIT", "x"), ("DYLD_INSERT_LIBRARIES", "x")] {
            assert!(stops_hook(&env(&[("PATH", "/usr/bin"), (k, v)])), "{k}={v}");
        }
    }

    #[test]
    fn other_variables_do_not_refuse() {
        for (k, v) in [("LD_PRELOAD", ""), ("LD_DEBUG", ""), ("ld_preload", "/example/x.so"), ("ld_trace_loaded_objects", "1"), ("LD_LIBRARY_PATH", "/example"), ("LD_SHOW_AUXV", "1"), ("NODE_OPTIONS", "--require x"), ("PATH", "/usr/bin")] {
            assert!(!stops_hook(&env(&[(k, v)])), "{k}={v}");
        }
    }

    #[test]
    fn clean_env_drops_every_loader_variable_and_keeps_the_rest() {
        let e = env(&[("PATH", "/usr/bin"), ("LD_LIBRARY_PATH", "/x"), ("HOME", "/h"), ("ld_show_auxv", "1"), ("NODE_OPTIONS", "--require x"), ("NODE_EXTRA_CA_CERTS", "/c"), ("DYLD_X", "1")]);
        let kept: Vec<String> = clean_env(&e).into_iter().map(|(k, _)| k.into_string().unwrap()).collect();
        assert_eq!(kept, ["PATH", "HOME", "NODE_EXTRA_CA_CERTS"]);
    }

    #[test]
    fn answers_in_each_agent_format() {
        let a = answer(Agent::ZCode, "PreToolUse", Why::Loader);
        assert_eq!(a, Answer { stdout: None, stderr: Some(LOADER_TEXT.to_string() + "\n"), code: 2 });
        assert_eq!(answer(Agent::ZCode, "PermissionRequest", Why::Loader).code, 2);
        assert_eq!(answer(Agent::ClaudeCode, "UserPromptExpansion", Why::Loader).code, 2);
        let a = answer(Agent::Antigravity, "PreToolUse", Why::Loader);
        assert_eq!(a.code, 0);
        assert_eq!(a.stdout.unwrap(), format!("{{\"decision\":\"deny\",\"reason\":\"{LOADER_TEXT}\"}}\n"));
        let a = answer(Agent::Copilot, "preToolUse", Why::Crash);
        assert_eq!(a.code, 2);
        assert_eq!(a.stdout.unwrap(), format!("{{\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"{CRASH_TEXT}\"}}\n"));
        let a = answer(Agent::Copilot, "postToolUse", Why::Loader);
        assert_eq!(a, Answer { stdout: None, stderr: Some(LOADER_WARN_TEXT.to_string() + "\n"), code: 0 });
        let a = answer(Agent::ClaudeCode, "PostToolUse", Why::Loader);
        assert_eq!(a.stdout.unwrap(), format!("{{\"systemMessage\":\"{LOADER_WARN_TEXT}\"}}\n"));
        assert_eq!(answer(Agent::Unknown, "PreToolUse", Why::Crash).code, 2);
    }

    #[test]
    fn events_are_plain_names() {
        assert_eq!(event_of(Some(&OsString::from("PreToolUse"))), "PreToolUse");
        assert_eq!(event_of(Some(&OsString::from("Pre ToolUse"))), "");
        assert_eq!(event_of(None), "");
    }

    #[test]
    fn json_escapes() {
        assert_eq!(json_string("a\"b\\c\n\u{1}"), "\"a\\\"b\\\\c\\n\\u0001\"");
    }
}
