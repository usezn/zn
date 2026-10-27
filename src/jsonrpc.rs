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
    // One frame is one object. Batches (arrays) are not supported, and a string, number, boolean or null
    // is not a request, so none of them is forwarded. The struct would read an array as a positional
    // struct (["2.0", {...}, "ping"] reads as jsonrpc, id, method) and forward the raw line unchecked.
    let first = json_str
        .bytes()
        .find(|b| !matches!(b, b' ' | b'\t' | b'\n' | b'\r'));
    if first != Some(b'{') {
        // Valid JSON that is not an object is an invalid request; anything else does not parse.
        return match serde_json::from_str::<serde::de::IgnoredAny>(json_str) {
            Ok(_) => JsonRpcValidation::Error {
                id: None,
                code: jsonrpc_error::INVALID_REQUEST,
                message:
                    "Invalid Request: a frame must be a single JSON object (batches are not supported)"
                        .to_string(),
            },
            Err(_) => JsonRpcValidation::Error {
                id: None,
                code: jsonrpc_error::PARSE_ERROR,
                message: "Parse error: Invalid JSON".to_string(),
            },
        };
    }
    // Straight into the struct, never through serde_json::Value: a Value keeps the last of two duplicate
    // keys, while the struct rejects them, so the method and params checked here are the only ones in
    // the raw line that is forwarded.
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn err(v: JsonRpcValidation) -> (Option<serde_json::Value>, i32, String) {
        match v {
            JsonRpcValidation::Error { id, code, message } => (id, code, message),
            other => panic!("expected Error, got {:?}", other),
        }
    }

    type Call = (
        Option<serde_json::Value>,
        String,
        String,
        Option<String>,
        ArgSource,
    );

    fn call(v: JsonRpcValidation) -> Call {
        match v {
            JsonRpcValidation::ToolCall {
                id,
                tool_name,
                arguments,
                agent_id,
                source,
            } => (id, tool_name, arguments, agent_id, source),
            other => panic!("expected ToolCall, got {:?}", other),
        }
    }

    const OK_CALL: &str = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"/home/user/example.txt"}}}"#;

    // ---- jsonrpc version ----

    #[test]
    fn version_2_0_is_accepted() {
        let (id, name, args, agent, source) = call(validate_jsonrpc(OK_CALL));
        assert_eq!(id, Some(json!(1)));
        assert_eq!(name, "read_file");
        assert_eq!(args, r#"{"path":"/home/user/example.txt"}"#);
        assert_eq!(agent, None);
        assert_eq!(source, ArgSource::Key("arguments"));
    }

    #[test]
    fn version_absent_is_accepted() {
        // Current behaviour: a missing "jsonrpc" member is tolerated (the spec requires it).
        let v = validate_jsonrpc(r#"{"id":1,"method":"tools/list"}"#);
        assert!(matches!(v, JsonRpcValidation::PassThrough));
    }

    #[test]
    fn version_wrong_string_is_rejected_and_keeps_id() {
        let (id, code, msg) = err(validate_jsonrpc(
            r#"{"jsonrpc":"1.0","id":"abc","method":"tools/call"}"#,
        ));
        assert_eq!(id, Some(json!("abc")));
        assert_eq!(code, jsonrpc_error::INVALID_REQUEST);
        assert!(msg.contains("'1.0'"), "{msg}");
    }

    #[test]
    fn version_variants_are_rejected() {
        for bad in [r#""2""#, r#""2.0.0""#, r#""""#, r#"" 2.0""#] {
            let frame = format!(r#"{{"jsonrpc":{bad},"id":1,"method":"x"}}"#);
            let (_, code, _) = err(validate_jsonrpc(&frame));
            assert_eq!(code, jsonrpc_error::INVALID_REQUEST, "{bad}");
        }
    }

    #[test]
    fn version_non_string_is_a_parse_error() {
        for bad in ["2.0", "2", "true", "[]", "{}"] {
            let frame = format!(r#"{{"jsonrpc":{bad},"id":1,"method":"x"}}"#);
            let (id, code, _) = err(validate_jsonrpc(&frame));
            assert_eq!(code, jsonrpc_error::PARSE_ERROR, "{bad}");
            assert_eq!(id, None);
        }
    }

    #[test]
    fn version_null_is_treated_as_absent() {
        let v = validate_jsonrpc(r#"{"jsonrpc":null,"id":1,"method":"ping"}"#);
        assert!(matches!(v, JsonRpcValidation::PassThrough));
    }

    // ---- id types ----

    #[test]
    fn id_number_string_null_missing_object() {
        let frame = |id: &str| {
            format!(r#"{{"jsonrpc":"2.0",{id}"method":"tools/call","params":{{"name":"t"}}}}"#)
        };
        let (id, ..) = call(validate_jsonrpc(&frame(r#""id":42,"#)));
        assert_eq!(id, Some(json!(42)));
        let (id, ..) = call(validate_jsonrpc(&frame(r#""id":"req-7","#)));
        assert_eq!(id, Some(json!("req-7")));
        let (id, ..) = call(validate_jsonrpc(&frame(r#""id":1.5,"#)));
        assert_eq!(id, Some(json!(1.5)));
        // null and missing both collapse to None
        let (id, ..) = call(validate_jsonrpc(&frame(r#""id":null,"#)));
        assert_eq!(id, None);
        let (id, ..) = call(validate_jsonrpc(&frame("")));
        assert_eq!(id, None);
        // Current behaviour: structured ids are passed through (the spec only allows string, number, null).
        let (id, ..) = call(validate_jsonrpc(&frame(r#""id":{"a":1},"#)));
        assert_eq!(id, Some(json!({"a": 1})));
        let (id, ..) = call(validate_jsonrpc(&frame(r#""id":[1],"#)));
        assert_eq!(id, Some(json!([1])));
    }

    #[test]
    fn id_is_echoed_in_errors() {
        let (id, ..) = err(validate_jsonrpc(r#"{"jsonrpc":"2.0","id":9,"method":""}"#));
        assert_eq!(id, Some(json!(9)));
        let (id, ..) = err(validate_jsonrpc(
            r#"{"jsonrpc":"2.0","id":"s","method":"tools/call"}"#,
        ));
        assert_eq!(id, Some(json!("s")));
    }

    // ---- method ----

    #[test]
    fn method_empty_or_missing_is_invalid_request() {
        for frame in [
            r#"{"jsonrpc":"2.0","id":1,"method":""}"#,
            r#"{"jsonrpc":"2.0","id":1}"#,
        ] {
            let (id, code, msg) = err(validate_jsonrpc(frame));
            assert_eq!(id, Some(json!(1)));
            assert_eq!(code, jsonrpc_error::INVALID_REQUEST);
            assert!(msg.contains("method is required"));
        }
    }

    #[test]
    fn method_non_string_is_a_parse_error() {
        for bad in ["1", "null", "true", "[]", r#"{"a":1}"#] {
            let frame = format!(r#"{{"jsonrpc":"2.0","id":1,"method":{bad}}}"#);
            let (_, code, _) = err(validate_jsonrpc(&frame));
            assert_eq!(code, jsonrpc_error::PARSE_ERROR, "{bad}");
        }
    }

    #[test]
    fn unknown_method_passes_through() {
        for m in [
            "initialize",
            "tools/list",
            "ping",
            "Tools/Call",
            "tools/call ",
        ] {
            let frame = format!(r#"{{"jsonrpc":"2.0","id":1,"method":"{m}"}}"#);
            assert!(
                matches!(validate_jsonrpc(&frame), JsonRpcValidation::PassThrough),
                "{m}"
            );
        }
    }

    // ---- tools/call params ----

    #[test]
    fn tools_call_without_params_is_invalid_params() {
        let (id, code, msg) = err(validate_jsonrpc(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call"}"#,
        ));
        assert_eq!(id, Some(json!(3)));
        assert_eq!(code, jsonrpc_error::INVALID_PARAMS);
        assert!(msg.contains("params"));
    }

    #[test]
    fn tools_call_bad_name_is_invalid_params() {
        for params in [
            r#"{}"#,
            r#"{"name":""}"#,
            r#"{"name":5}"#,
            r#"{"name":null}"#,
            r#"{"name":["a"]}"#,
            r#"[]"#,
            r#""text""#,
        ] {
            let frame =
                format!(r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{params}}}"#);
            let (_, code, msg) = err(validate_jsonrpc(&frame));
            assert_eq!(code, jsonrpc_error::INVALID_PARAMS, "{params}");
            assert!(msg.contains("tool name"), "{params}: {msg}");
        }
    }

    #[test]
    fn tools_call_null_params_is_treated_as_missing() {
        // "params":null deserializes to None, so it reports the missing-params error.
        let (_, code, msg) = err(validate_jsonrpc(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":null}"#,
        ));
        assert_eq!(code, jsonrpc_error::INVALID_PARAMS);
        assert!(msg.contains("params object required"));
    }

    #[test]
    fn tools_call_argument_keys_and_priority() {
        let frame =
            |p: &str| format!(r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{p}}}"#);
        let (_, _, a, _, s) = call(validate_jsonrpc(&frame(r#"{"name":"t","args":{"x":1}}"#)));
        assert_eq!((a.as_str(), s), (r#"{"x":1}"#, ArgSource::Key("args")));
        let (_, _, a, _, s) = call(validate_jsonrpc(&frame(r#"{"name":"t","input":[1,2]}"#)));
        assert_eq!((a.as_str(), s), ("[1,2]", ArgSource::Key("input")));
        // "arguments" wins over "args", which wins over "input"
        let (_, _, a, _, s) = call(validate_jsonrpc(&frame(
            r#"{"name":"t","input":3,"args":2,"arguments":1}"#,
        )));
        assert_eq!((a.as_str(), s), ("1", ArgSource::Key("arguments")));
        let (_, _, a, _, s) = call(validate_jsonrpc(&frame(
            r#"{"name":"t","input":3,"args":2}"#,
        )));
        assert_eq!((a.as_str(), s), ("2", ArgSource::Key("args")));
        // Missing -> "{}"
        let (_, _, a, _, s) = call(validate_jsonrpc(&frame(r#"{"name":"t"}"#)));
        assert_eq!((a.as_str(), s), ("{}", ArgSource::Missing));
        // An explicit null still counts as present
        let (_, _, a, _, s) = call(validate_jsonrpc(&frame(r#"{"name":"t","arguments":null}"#)));
        assert_eq!((a.as_str(), s), ("null", ArgSource::Key("arguments")));
    }

    #[test]
    fn tools_call_carries_agent_id() {
        let frame = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","agent_id":"agent-example","params":{"name":"t"}}"#;
        let (_, _, _, agent, _) = call(validate_jsonrpc(frame));
        assert_eq!(agent.as_deref(), Some("agent-example"));
        let bad =
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","agent_id":7,"params":{"name":"t"}}"#;
        let (_, code, _) = err(validate_jsonrpc(bad));
        assert_eq!(code, jsonrpc_error::PARSE_ERROR);
    }

    // ---- A2A ----

    #[test]
    fn a2a_methods_use_whole_params() {
        let frame = r#"{"jsonrpc":"2.0","id":"t1","method":"tasks/send","params":{"recipient":"finance-agent","task":{"k":"v"}}}"#;
        let (id, name, args, _, source) = call(validate_jsonrpc(frame));
        assert_eq!(id, Some(json!("t1")));
        assert_eq!(name, "a2a:send:finance-agent");
        assert_eq!(source, ArgSource::WholeParams);
        let parsed: serde_json::Value = serde_json::from_str(&args).unwrap();
        assert_eq!(parsed["task"]["k"], "v");
    }

    #[test]
    fn a2a_without_params_uses_empty_object_and_action_only_name() {
        for (m, n) in [
            ("tasks/send", "a2a:send"),
            ("tasks/get", "a2a:get"),
            ("tasks/list", "a2a:list"),
            ("tasks/cancel", "a2a:cancel"),
        ] {
            let frame = format!(r#"{{"jsonrpc":"2.0","id":1,"method":"{m}"}}"#);
            let (_, name, args, _, source) = call(validate_jsonrpc(&frame));
            assert_eq!((name.as_str(), args.as_str()), (n, "{}"));
            assert_eq!(source, ArgSource::WholeParams);
        }
    }

    #[test]
    fn a2a_empty_or_non_string_recipient_falls_back_to_action() {
        for p in [r#"{"recipient":""}"#, r#"{"recipient":5}"#, r#"[1]"#] {
            let frame = format!(r#"{{"jsonrpc":"2.0","id":1,"method":"tasks/get","params":{p}}}"#);
            let (_, name, _, _, _) = call(validate_jsonrpc(&frame));
            assert_eq!(name, "a2a:get", "{p}");
        }
    }

    #[test]
    fn a2a_still_checks_version() {
        let (_, code, _) = err(validate_jsonrpc(
            r#"{"jsonrpc":"3.0","id":1,"method":"tasks/send"}"#,
        ));
        assert_eq!(code, jsonrpc_error::INVALID_REQUEST);
    }

    // ---- batches and broken JSON ----

    #[test]
    fn batch_arrays_are_an_invalid_request() {
        // The validator takes one request object; any array is valid JSON but not a request (-32600).
        let mixed = format!(r#"[{OK_CALL},{{"jsonrpc":"1.0","method":"x"}},5]"#);
        let single = format!("[{OK_CALL}]");
        for b in ["[]", "[{}]", "[1,2,3]", single.as_str(), mixed.as_str()] {
            let (id, code, msg) = err(validate_jsonrpc(b));
            assert_eq!(id, None, "{b}");
            assert_eq!(code, jsonrpc_error::INVALID_REQUEST, "{b}");
            assert!(msg.starts_with("Invalid Request"));
        }
    }

    #[test]
    fn non_object_json_is_an_invalid_request() {
        for s in ["null", "true", "42", r#""text""#] {
            let (_, code, _) = err(validate_jsonrpc(s));
            assert_eq!(code, jsonrpc_error::INVALID_REQUEST, "{s}");
        }
    }

    #[test]
    fn broken_json_is_a_parse_error() {
        for s in [
            "",
            "   ",
            "{",
            "}",
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call""#,
            r#"{"jsonrpc":"2.0",}"#,
            "{'jsonrpc':'2.0'}",
            "\u{0}",
            r#"{"jsonrpc":"2.0","method":"a"} trailing"#,
        ] {
            let (id, code, _) = err(validate_jsonrpc(s));
            assert_eq!(code, jsonrpc_error::PARSE_ERROR, "{s:?}");
            assert_eq!(id, None);
        }
    }

    #[test]
    fn unknown_members_and_surrounding_whitespace_are_ignored() {
        let frame = "  \n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"extra\":[1,2]}\n ";
        assert!(matches!(
            validate_jsonrpc(frame),
            JsonRpcValidation::PassThrough
        ));
    }

    // ---- size ----
    // validate_jsonrpc has no size cap of its own (frame limits live in the transport handlers),
    // so these tests pin that large frames are handled without error or truncation.

    #[test]
    fn large_frames_are_not_truncated() {
        for size in [
            1024 * 1024 - 1,
            1024 * 1024,
            1024 * 1024 + 1,
            4 * 1024 * 1024,
        ] {
            let blob = "a".repeat(size);
            let frame = format!(
                r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"t","arguments":{{"data":"{blob}"}}}}}}"#
            );
            let (_, name, args, _, _) = call(validate_jsonrpc(&frame));
            assert_eq!(name, "t");
            assert_eq!(args.len(), size + r#"{"data":""}"#.len());
        }
    }

    #[test]
    fn deeply_nested_json_does_not_panic() {
        let depth = 10_000;
        let frame = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"ping","params":{}{}}}"#,
            "[".repeat(depth),
            "]".repeat(depth)
        );
        let (_, code, _) = err(validate_jsonrpc(&frame));
        assert_eq!(code, jsonrpc_error::PARSE_ERROR);
    }

    #[test]
    fn unicode_names_and_values_round_trip() {
        let frame = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"herramienta-ñ","arguments":{"texto":"añejo é"}}}"#;
        let (_, name, args, _, _) = call(validate_jsonrpc(frame));
        assert_eq!(name, "herramienta-ñ");
        assert!(args.contains("añejo é"));
    }

    // ---- with_arguments ----

    const FRAME: &str = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"t","arguments":{"a":1}}}"#;

    fn parse(s: &str) -> serde_json::Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn with_arguments_key_replaces_only_that_key() {
        let out = with_arguments(FRAME, r#"{"b":[2]}"#, ArgSource::Key("arguments")).unwrap();
        let v = parse(&out);
        assert_eq!(v["params"]["arguments"], json!({"b": [2]}));
        assert_eq!(v["params"]["name"], "t");
        assert_eq!(v["id"], 1);
        assert_eq!(v["method"], "tools/call");
    }

    #[test]
    fn with_arguments_key_requires_existing_key() {
        assert!(with_arguments(FRAME, "{}", ArgSource::Key("args")).is_none());
        assert!(with_arguments(FRAME, "{}", ArgSource::Key("input")).is_none());
    }

    #[test]
    fn with_arguments_key_accepts_non_object_values() {
        let out = with_arguments(FRAME, "null", ArgSource::Key("arguments")).unwrap();
        assert!(parse(&out)["params"]["arguments"].is_null());
        let out = with_arguments(FRAME, "[1,2]", ArgSource::Key("arguments")).unwrap();
        assert_eq!(parse(&out)["params"]["arguments"], json!([1, 2]));
    }

    #[test]
    fn with_arguments_whole_params_replaces_params() {
        let frame =
            r#"{"jsonrpc":"2.0","id":2,"method":"tasks/send","params":{"recipient":"a","task":1}}"#;
        let out = with_arguments(frame, r#"{"recipient":"b"}"#, ArgSource::WholeParams).unwrap();
        let v = parse(&out);
        assert_eq!(v["params"], json!({"recipient": "b"}));
        assert_eq!(v["method"], "tasks/send");
    }

    #[test]
    fn with_arguments_whole_params_needs_a_params_member() {
        let frame = r#"{"jsonrpc":"2.0","id":2,"method":"tasks/list"}"#;
        assert!(with_arguments(frame, "{}", ArgSource::WholeParams).is_none());
    }

    #[test]
    fn with_arguments_missing_source_is_always_none() {
        let frame = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"t"}}"#;
        assert!(with_arguments(frame, r#"{"x":1}"#, ArgSource::Missing).is_none());
        assert!(with_arguments(FRAME, r#"{"x":1}"#, ArgSource::Missing).is_none());
    }

    #[test]
    fn with_arguments_rejects_unparseable_input() {
        assert!(with_arguments("not json", "{}", ArgSource::Key("arguments")).is_none());
        assert!(with_arguments(FRAME, "{broken", ArgSource::Key("arguments")).is_none());
        assert!(with_arguments(FRAME, "", ArgSource::WholeParams).is_none());
    }

    #[test]
    fn with_arguments_without_params_is_none() {
        let frame = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        assert!(with_arguments(frame, "{}", ArgSource::Key("arguments")).is_none());
        assert!(with_arguments(frame, "{}", ArgSource::WholeParams).is_none());
    }

    #[test]
    fn with_arguments_non_object_params_does_not_panic() {
        // params is an array / string: Key lookup finds nothing, WholeParams still replaces it
        let frame = r#"{"jsonrpc":"2.0","id":1,"method":"x","params":[1,2]}"#;
        assert!(with_arguments(frame, "{}", ArgSource::Key("arguments")).is_none());
        assert!(with_arguments(frame, "{}", ArgSource::WholeParams).is_some());
        let frame = r#"{"jsonrpc":"2.0","id":1,"method":"x","params":"s"}"#;
        assert!(with_arguments(frame, "{}", ArgSource::Key("arguments")).is_none());
    }

    #[test]
    fn with_arguments_round_trips_validate_jsonrpc_source() {
        for frame in [
            FRAME,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"t","args":{"a":1}}}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"t","input":{"a":1}}}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":"tasks/get","params":{"recipient":"r"}}"#,
        ] {
            let (_, _, args, _, source) = call(validate_jsonrpc(frame));
            let rebuilt = with_arguments(frame, &args, source).unwrap();
            assert_eq!(parse(&rebuilt), parse(frame));
        }
    }
}
