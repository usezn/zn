"""
zn-gate client module: local deterministic rules, with an optional cloud second
opinion for prompt analysis. Pure Python stdlib. Zero external dependencies.

Data-flow contract (since 1.4.1): `analyze()` only contacts the network when the
user explicitly opted in with BOTH `ZN_API_KEY` and `ZN_CLOUD=1` (and
`ZN_LOCAL_ONLY` is not "true"). Secrets are redacted locally with
`redact_secrets()` before the request is built. Tool results and tool-call
arguments (guard, integrations, sanitize_tool_result) are always local.
"""

from __future__ import annotations

import json
import os
import urllib.request
import urllib.error
from typing import Any, Dict, Optional

from .rules import evaluate, redact_secrets, Assessment, RULES_VERSION
from . import __version__

DEFAULT_ENDPOINT = "https://api.usezn.com/v30/analyze"


def resolve_endpoint(options: Optional[Dict[str, Any]] = None) -> str:
    options = options or {}
    if "api_url" in options and options["api_url"]:
        return options["api_url"]
    if os.environ.get("ZN_API_URL"):
        return os.environ["ZN_API_URL"]
    stage = options.get("stage") or os.environ.get("ZN_STAGE") or "v30"
    if stage == "prod":
        return "https://api.usezn.com/prod/analyze"
    return DEFAULT_ENDPOINT


def is_cloud_enabled(api_key: Optional[str] = None, local_only: bool = False) -> bool:
    """True only if the user opted in: an API key AND ZN_CLOUD=1, and no local-only override."""
    key = api_key or os.environ.get("ZN_API_KEY")
    opted_in = os.environ.get("ZN_CLOUD") == "1"
    force_local = local_only or os.environ.get("ZN_LOCAL_ONLY") == "true"
    return bool(key) and opted_in and not force_local


# Long texts: the cloud gate reads the first 512 tokens unless the request
# asks for overlapping windows ("long_input": "windows": 512-token windows,
# stride 256, up to 20; the verdict comes from the window with the highest
# score). Same rule as the Node.js client (lib/client.js): text over
# LONG_INPUT_MIN_CHARS asks for windows unless ZN_LONG_INPUT / long_input is
# "off". Each window is one more inference, so the default timeout is longer.
LONG_INPUT_MIN_CHARS = 1000
WINDOWS_TIMEOUT = 12.0


def long_input_mode(value: Optional[str] = None) -> str:
    v = str(value if value is not None else os.environ.get("ZN_LONG_INPUT", "windows")).strip().lower()
    return "off" if v in ("off", "none", "truncate", "0", "false", "no") else "windows"


def analyze_cloud(
    input_text: str,
    api_key: str,
    endpoint_url: Optional[str] = None,
    timeout: float = 4.0,
    long_input: Optional[str] = None,
) -> Dict[str, Any]:
    """Sends a payload to the zn cloud gate (stdlib urllib). Secrets are always redacted first."""
    endpoint = endpoint_url or DEFAULT_ENDPOINT
    redacted, _ = redact_secrets(input_text)
    body: Dict[str, Any] = {"input": redacted}
    if long_input == "windows":
        body["long_input"] = "windows"
    payload = json.dumps(body).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key.strip()}",
        "User-Agent": f"zn-gate/{__version__} (python-stdlib-client)",
    }
    req = urllib.request.Request(endpoint, data=payload, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
        parsed = json.loads(body)
        parsed["engine"] = "cloud-v30" if "/v30" in endpoint else "cloud-prod"
        return parsed


def analyze(
    input_text: str,
    api_key: Optional[str] = None,
    endpoint: Optional[str] = None,
    timeout: Optional[float] = None,
    local_only: bool = False,
    long_input: Optional[str] = None,
    **kwargs: Any,
) -> Dict[str, Any]:
    """
    Prompt analysis. Local deterministic rules first; if they block, return at once.
    Only if the user opted in (ZN_API_KEY + ZN_CLOUD=1) is the text, with secrets
    redacted locally, also sent to the zn cloud gate. Otherwise nothing leaves the machine.
    """
    key = api_key or os.environ.get("ZN_API_KEY")

    # 1. Local fast path (no network)
    local_eval = evaluate(input_text)
    if not local_eval.allowed:
        return {
            "verdict": "block",
            "confidence": local_eval.confidence,
            "rule": local_eval.rule,
            "reason": local_eval.reason,
            "mode": "hybrid-local-fastpath",
            "engine": "oss-local",
            "rules_version": local_eval.rules_version,
            "latency_us": 5,
        }

    # Cloud is opt-in: without ZN_CLOUD=1 (or with ZN_LOCAL_ONLY) everything stays local
    if not is_cloud_enabled(key, local_only):
        return {
            "verdict": "allow",
            "confidence": local_eval.confidence,
            "rule": "none",
            "reason": None,
            "mode": "oss-local",
            "engine": "oss-local",
            "rules_version": local_eval.rules_version,
        }

    # 2. Cloud Gate deep neural analysis
    target_url = endpoint or resolve_endpoint(kwargs)
    try:
        sanitized, detections = redact_secrets(input_text)
        # Length in UTF-16 units, as the Node.js client counts it.
        windows = long_input_mode(long_input) == "windows" and len(sanitized.encode("utf-16-le")) // 2 > LONG_INPUT_MIN_CHARS
        cloud_res = analyze_cloud(input_text, key, target_url,
                                  timeout=timeout if timeout is not None else (WINDOWS_TIMEOUT if windows else 4.0),
                                  long_input="windows" if windows else None)
        cloud_res["mode"] = "hybrid-cloud"
        cloud_res["secrets_redacted_before_upload"] = len(detections)
        li = cloud_res.get("long_input")
        if isinstance(li, dict) and li.get("capped"):
            cloud_res["warning"] = ("The text is longer than the cloud gate checks (%s windows of 512 tokens): "
                                    "the end was not analyzed." % li.get("windows"))
        elif windows and isinstance(li, dict) and li.get("mode") == "truncate":
            cloud_res["warning"] = ("The cloud gate checked only the first 512 tokens of this text (%s)."
                                    % (li.get("reason") or "no windows"))
        return cloud_res
    except Exception as exc:
        if os.environ.get("DEBUG") or os.environ.get("ZN_VERBOSE"):
            import sys
            sys.stderr.write(f"[zn-gate] Warning: Cloud gate error ({exc}). Using local OSS rules fallback.\n")
        return {
            "verdict": "allow",
            "confidence": local_eval.confidence,
            "rule": "none",
            "reason": None,
            "mode": "oss-local-fallback",
            "engine": "oss-local",
            "fallback": True,
            "cloud_error": str(exc),
        }
