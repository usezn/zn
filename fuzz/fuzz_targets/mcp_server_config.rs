//! The MCP servers file (mcp_servers.json) the gateway reads from the user's home: arbitrary bytes must never
//! panic the loader, and every server it keeps with a command has an allowed one (checked inside the hook).
//! `fuzz_load_config_file` exists only when the crate is built with `--cfg fuzzing` (cargo-fuzz does that).
#![no_main]

use libfuzzer_sys::fuzz_target;
use std::io::Write;

fuzz_target!(|data: &[u8]| {
    // One file per process, rewritten on each run, in the system temp folder.
    let path = std::env::temp_dir().join(format!("zn-fuzz-mcp-{}.json", std::process::id()));
    let Ok(mut file) = std::fs::File::create(&path) else {
        return;
    };
    if file.write_all(data).is_err() {
        return;
    }
    drop(file);
    let Some(path) = path.to_str() else {
        return;
    };
    let _ = zn::proxy::fuzz_load_config_file(path);
});
