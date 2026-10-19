//! JSON-RPC request validation for MCP and A2A frames: the one place that reads the text a client sends
//! and decides whether it is a tool call, something to pass through, or an error.

/// JSON-RPC 2.0 request structure with full spec compliance
#[derive(serde::Deserialize, serde::Serialize, Debug, Clone)]
pub struct JsonRpcRequest {
    /// JSON-RPC version - must be "2.0"
    pub jsonrpc: Option<String>,
    /// Request ID (can be string, number, or null for notifications)
    #[serde(default)]
    pub id: Option<serde_json::Value>,
    /// Method name
    #[serde(default)]
    pub method: String,
    /// Parameters (positional array or named object)
    #[serde(default)]
    pub params: Option<serde_json::Value>,
    /// Optional Agent Identifier
    #[serde(default)]
    pub agent_id: Option<String>,
}

/// JSON-RPC 2.0 error codes
pub mod jsonrpc_error {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const POLICY_DENIED: i32 = -32000; // Server error range
}

/// Where validate_jsonrpc took the tool arguments from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ArgSource {
    /// `params.<key>` of a tools/call (`arguments`, `args` or `input`).
    Key(&'static str),
    /// No arguments in the frame (checked as `{}`).
    Missing,
    /// The whole `params` (A2A methods).
    WholeParams,
}

/// The JSON-RPC frame with its tool arguments replaced by `arguments` (a JSON text), in exactly the place
/// validate_jsonrpc took them from. None if either side does not parse or that place is not there.
/// serde_json does not keep key order, so the rebuilt frame may list keys in another order.
pub fn with_arguments(frame: &str, arguments: &str, source: ArgSource) -> Option<String> {
    let mut v: serde_json::Value = serde_json::from_str(frame).ok()?;
    let new_args: serde_json::Value = serde_json::from_str(arguments).ok()?;
    let params = v.get_mut("params")?;
    match source {
        ArgSource::Key(k) => {
            params.get(k)?;
            params[k] = new_args;
        }
        ArgSource::WholeParams => *params = new_args,
        ArgSource::Missing => return None,
    }
    serde_json::to_string(&v).ok()
}

/// Result of validating a JSON-RPC request
#[derive(Debug)]
pub enum JsonRpcValidation {
    /// Valid tool call with extracted name and arguments
    ToolCall {
        id: Option<serde_json::Value>,
        tool_name: String,
        arguments: String,
        agent_id: Option<String>,
        source: ArgSource,
    },
    /// Valid JSON-RPC but not a tool call - pass through
    PassThrough,
    /// Invalid JSON-RPC - return error response
    Error {
        id: Option<serde_json::Value>,
        code: i32,
        message: String,
    },
}

/// Validate and extract tool call from JSON-RPC request
pub fn validate_jsonrpc(json_str: &str) -> JsonRpcValidation {
    // Parse JSON
    let request: JsonRpcRequest = match serde_json::from_str(json_str) {
        Ok(r) => r,
        Err(_) => {
            return JsonRpcValidation::Error {
                id: None,
                code: jsonrpc_error::PARSE_ERROR,
                message: "Parse error: Invalid JSON".to_string(),
            }
        }
    };

    // Validate JSON-RPC version if present
    if let Some(ref version) = request.jsonrpc {
        if version != "2.0" {
            return JsonRpcValidation::Error {
                id: request.id,
                code: jsonrpc_error::INVALID_REQUEST,
                message: format!("Invalid Request: jsonrpc must be '2.0', got '{}'", version),
            };
        }
    }

    // Check if method is empty
    if request.method.is_empty() {
        return JsonRpcValidation::Error {
            id: request.id,
            code: jsonrpc_error::INVALID_REQUEST,
            message: "Invalid Request: method is required".to_string(),
        };
    }

    // Check for Tool Call OR A2A Task
    if request.method == "tools/call" {
        let params = match request.params {
            Some(p) => p,
            None => {
                return JsonRpcValidation::Error {
                    id: request.id,
                    code: jsonrpc_error::INVALID_PARAMS,
                    message: "Invalid params: params object required".to_string(),
                }
            }
        };

        let tool_name = match params
            .get("name")
            .and_then(|n| n.as_str())
            .map(|s| s.to_string())
        {
            Some(n) if !n.is_empty() => n,
            _ => {
                return JsonRpcValidation::Error {
                    id: request.id,
                    code: jsonrpc_error::INVALID_PARAMS,
                    message: "Invalid params: tool name is required".to_string(),
                }
            }
        };

        // Extract arguments as JSON string
        let source = ["arguments", "args", "input"]
            .into_iter()
            .find(|k| params.get(*k).is_some())
            .map(ArgSource::Key)
            .unwrap_or(ArgSource::Missing);
        let arguments = match source {
            ArgSource::Key(k) => params[k].to_string(),
            _ => "{}".to_string(),
        };

        return JsonRpcValidation::ToolCall {
            id: request.id,
            tool_name,
            arguments,
            agent_id: request.agent_id,
            source,
        };
    } else if crate::a2a::is_a2a_method(&request.method) {
        // A2A Protocol Handler - Full Parity
        let params = match request.params {
            Some(p) => p,
            None => serde_json::json!({}),
        };

        // Use robust policy resolution from A2A module
        let virt_tool_name = crate::a2a::resolve_policy_context(&request.method, &params);

        // For A2A, the "arguments" for inspection are the full task payload
        let arguments = params.to_string();

        return JsonRpcValidation::ToolCall {
            id: request.id,
            tool_name: virt_tool_name,
            arguments,
            agent_id: request.agent_id,
            source: ArgSource::WholeParams,
        };
    }

    JsonRpcValidation::PassThrough
}
