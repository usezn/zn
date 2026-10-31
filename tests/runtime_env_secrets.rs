//! Keeping keys and tokens out of the file `zn init` writes must not change
//! the runtime: a default configuration still reads them from the environment.
//! This file is its own test binary, so setting variables here is local.

use zn::config::ZnConfig;

#[test]
fn runtime_config_reads_secrets_from_the_environment_but_the_init_file_does_not() {
    std::env::set_var("ZN_MCP_WS_TOKEN", "fake-ws-token-0000-not-real");
    std::env::set_var("ZN_API_KEY", "fake-api-key-0000-not-real");
    std::env::set_var("ZN_DB_KEY", "fake-db-key-0000-not-real");

    let runtime = ZnConfig::default();
    assert_eq!(
        runtime.security.mcp_ws_token.as_deref(),
        Some("fake-ws-token-0000-not-real")
    );
    assert_eq!(
        runtime.security.api_key.as_deref(),
        Some("fake-api-key-0000-not-real")
    );
    assert_eq!(
        runtime.audit.encryption_key.as_deref(),
        Some("fake-db-key-0000-not-real")
    );

    let template = ZnConfig::init_template();
    assert!(template.security.mcp_ws_token.is_none());
    assert!(template.security.api_key.is_none());
    assert!(template.audit.encryption_key.is_none());
    let json = serde_json::to_string(&template).expect("json");
    assert!(!json.contains("not-real"), "a value reached the init file");
}
