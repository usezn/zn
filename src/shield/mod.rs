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
            // Default to only localhost
            return origin.contains("localhost") || origin.contains("127.0.0.1");
        }
        allowed_origins.iter().any(|o| origin == o)
    }

    /// Generate an ephemeral auth token for WS
    pub fn generate_ws_token() -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

pub mod canary {

    /// Detect potential Shodan scans based on specific JSON-RPC patterns
    pub fn is_shodan_probe(payload: &str) -> bool {
        // Shodan often uses these patterns to identify MCP servers
        payload.contains("\"method\":\"initialize\"") && payload.contains("\"jsonrpc\":\"2.0\"")
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
}
