use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize)]
pub struct ScanResult {
    pub port: u16,
    pub is_open: bool,
    pub service: String,
    pub vulnerable: bool,
}

pub struct McpShield;

impl McpShield {
    /// Scan for common MCP ports exposed on 0.0.0.0
    pub fn scan_local_exposure() -> Vec<ScanResult> {
        let common_ports = [3000, 8000, 8080, 9090, 50051];
        let mut results = Vec::new();

        for port in common_ports {
            let addr = format!("0.0.0.0:{}", port);
            let socket_addr: SocketAddr = addr.parse().unwrap();

            let is_open =
                TcpStream::connect_timeout(&socket_addr, Duration::from_millis(50)).is_ok();

            if is_open {
                results.push(ScanResult {
                    port,
                    is_open: true,
                    service: "Potential MCP/Web".to_string(),
                    vulnerable: true,
                });
            }
        }
        results
    }

    /// Check if a WebSocket origin is allowed
    pub fn validate_origin(origin: &str, allowed_origins: &[String]) -> bool {
        if allowed_origins.is_empty() {
            // Default: only loopback origins
            return is_loopback_origin(origin);
        }
        allowed_origins.iter().any(|o| origin == o)
    }

    /// Generate an ephemeral auth token for WS
    /// Startup message about the MCP WebSocket token. It names where the
    /// token is, never the token itself, so it does not reach terminals,
    /// container logs or journals.
    pub fn ws_token_notice(token_file: Option<&std::path::Path>) -> String {
        match token_file {
            Some(file) => format!(
                "MCP WebSocket token: generated and saved to {} (readable only by you)",
                file.display()
            ),
            None => "MCP WebSocket token: taken from ZN_MCP_WS_TOKEN (not shown)".to_string(),
        }
    }

    pub fn generate_ws_token() -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

/// True when `origin` is exactly `http(s)://<loopback host>[:port]`, where the
/// host is `localhost`, `127.0.0.1` or `[::1]`. Anything else is rejected:
/// malformed values, userinfo, paths, other hosts, subdomains, trailing dots.
fn is_loopback_origin(origin: &str) -> bool {
    let (scheme, rest) = match origin.split_once("://") {
        Some(parts) => parts,
        None => return false,
    };
    if !(scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")) {
        return false;
    }
    // An origin has no path, query or fragment; tolerate one trailing slash.
    let authority = rest.strip_suffix('/').unwrap_or(rest);
    if authority.is_empty()
        || authority
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '[' | ']' | '-')))
    {
        return false;
    }
    let (host, port) = if let Some(after) = authority.strip_prefix('[') {
        match after.split_once(']') {
            Some((h, tail)) => match tail {
                "" => (&authority[..h.len() + 2], None),
                t => match t.strip_prefix(':') {
                    Some(p) => (&authority[..h.len() + 2], Some(p)),
                    None => return false,
                },
            },
            None => return false,
        }
    } else {
        match authority.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        }
    };
    if let Some(p) = port {
        if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        if p.parse::<u32>().map_or(true, |n| n > 65535) {
            return false;
        }
    }
    host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "[::1]"
}

pub mod canary {

    /// Detect potential Shodan scans based on specific JSON-RPC patterns
    pub fn is_shodan_probe(payload: &str) -> bool {
        // Shodan often uses these patterns to identify MCP servers
        payload.contains("\"method\":\"initialize\"") && payload.contains("\"jsonrpc\":\"2.0\"")
    }
}

#[cfg(test)]
mod origin_tests {
    use super::McpShield;

    fn ok(o: &str) -> bool {
        McpShield::validate_origin(o, &[])
    }

    #[test]
    fn default_accepts_loopback_origins() {
        for o in [
            "http://localhost",
            "https://localhost",
            "http://localhost:5173",
            "http://127.0.0.1:9090",
            "https://127.0.0.1",
            "http://[::1]",
            "http://[::1]:8080",
            "http://LOCALHOST:3000",
            "http://localhost/",
        ] {
            assert!(ok(o), "should accept {o}");
        }
    }

    #[test]
    fn default_rejects_lookalikes_and_malformed() {
        for o in [
            "",
            "null",
            "localhost",
            "https://localhost.example.net",
            "http://evil.test/?localhost",
            "http://evil.test/#127.0.0.1",
            r"http://localhost@evil.test",
            "http://evil.test@localhost",
            "http://localhost:80@evil.test",
            "http://localhost.",
            "http://sub.localhost",
            "http://notlocalhost",
            "http://localhost.evil.test",
            "http://127.0.0.1.evil.test",
            "http://127.0.0.2",
            "http://[::2]",
            "http://[::1",
            "http://[::1]x",
            "http://localhost:",
            "http://localhost:abc",
            "http://localhost:99999",
            "http://localhost/path",
            r"http://localhost\@evil.test",
            "ftp://localhost",
            "ws://localhost",
            "file://localhost",
            "http://",
            "://localhost",
            " http://localhost",
            "http://localhost ",
            "http://local host",
        ] {
            assert!(!ok(o), "should reject {o}");
        }
    }

    #[test]
    fn explicit_list_uses_exact_matching() {
        let list = vec!["https://app.example.test".to_string()];
        assert!(McpShield::validate_origin(
            "https://app.example.test",
            &list
        ));
        assert!(!McpShield::validate_origin("http://localhost", &list));
        assert!(!McpShield::validate_origin(
            "https://app.example.test.evil.test",
            &list
        ));
        assert!(!McpShield::validate_origin("", &list));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_origins_allow_only_localhost() {
        assert!(McpShield::validate_origin("http://localhost:3000", &[]));
        assert!(McpShield::validate_origin("http://127.0.0.1:8080", &[]));
        assert!(!McpShield::validate_origin("https://example.com", &[]));
        assert!(!McpShield::validate_origin("", &[]));
    }

    #[test]
    fn explicit_origins_require_exact_match() {
        let allowed = vec!["https://app.example.com".to_string()];
        assert!(McpShield::validate_origin(
            "https://app.example.com",
            &allowed
        ));
        assert!(!McpShield::validate_origin(
            "https://app.example.com/",
            &allowed
        ));
        assert!(!McpShield::validate_origin(
            "https://other.example.com",
            &allowed
        ));
        // An explicit list replaces the localhost default.
        assert!(!McpShield::validate_origin("http://localhost", &allowed));
    }

    #[test]
    fn ws_tokens_are_valid_uuids_and_unique() {
        let a = McpShield::generate_ws_token();
        let b = McpShield::generate_ws_token();
        assert_ne!(a, b);
        assert!(uuid::Uuid::parse_str(&a).is_ok());
        assert!(uuid::Uuid::parse_str(&b).is_ok());
    }

    #[test]
    fn scan_reports_only_open_known_ports() {
        let known = [3000u16, 8000, 8080, 9090, 50051];
        for r in McpShield::scan_local_exposure() {
            assert!(known.contains(&r.port));
            assert!(r.is_open && r.vulnerable);
            assert!(!r.service.is_empty());
        }
    }

    #[test]
    fn scan_result_serializes_to_json() {
        let r = ScanResult {
            port: 8080,
            is_open: true,
            service: "Potential MCP/Web".to_string(),
            vulnerable: true,
        };
        let v: serde_json::Value = serde_json::to_value(&r).unwrap();
        assert_eq!(v["port"], 8080);
        assert_eq!(v["is_open"], true);
        let back: ScanResult = serde_json::from_value(v).unwrap();
        assert_eq!(back.port, 8080);
    }

    #[test]
    fn canary_detects_initialize_probe() {
        let probe = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
        assert!(canary::is_shodan_probe(probe));
    }

    #[test]
    fn canary_ignores_other_payloads() {
        assert!(!canary::is_shodan_probe(""));
        assert!(!canary::is_shodan_probe(
            r#"{"jsonrpc":"2.0","method":"tools/list"}"#
        ));
        assert!(!canary::is_shodan_probe(r#"{"method":"initialize"}"#));
    }

    #[test]
    fn ws_token_notice_never_contains_the_token() {
        let token = "fake-ws-token-0000";
        let file = std::path::Path::new("/data/zn-mcp-ws-token.txt");
        let generated = McpShield::ws_token_notice(Some(file));
        assert!(generated.contains("zn-mcp-ws-token.txt"));
        assert!(!generated.contains(token));
        assert!(!McpShield::ws_token_notice(None).contains(token));
    }
}
