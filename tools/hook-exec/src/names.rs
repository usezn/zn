//! The loader variables to remove. Same list as packages/zn-gate/lib/loader-env.js (SH_UNSET_NAMES and LOADER_NAMES, plus
//! every LD_* and DYLD_* name); the test packages/zn-gate/test/hook_exec_names.test.js fails when the two drift apart.

pub const PREFIXES: &[&[u8]] = &[b"LD_", b"DYLD_"];

pub const EXACT: &[&str] = &[
    "GCONV_PATH", "GLIBC_TUNABLES", "LOCPATH", "NLSPATH", "HOSTALIASES", "RES_OPTIONS", "OPENSSL_CONF",
    "NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE", "NODE_V8_COVERAGE",
    "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT", "PERL5OPT", "PERL5LIB", "PERLLIB",
    "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "BASH_ENV", "ENV",
];

/// True for a name to remove. Unix names are case sensitive, so exact case only.
pub fn is_loader_name(name: &[u8]) -> bool {
    PREFIXES.iter().any(|p| name.starts_with(p)) || EXACT.iter().any(|e| e.as_bytes() == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_and_names() {
        for n in ["LD_PRELOAD", "LD_DEBUG", "LD_TRACE_LOADED_OBJECTS", "LD_ANYTHING_NEW", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "BASH_ENV", "ENV"] {
            assert!(is_loader_name(n.as_bytes()), "{n}");
        }
        for n in ["PATH", "HOME", "LDFLAGS", "ENVIRONMENT", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "ld_preload"] {
            assert!(!is_loader_name(n.as_bytes()), "{n}");
        }
    }
}
