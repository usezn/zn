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


def analyze_cloud(
    input_text: str,
    api_key: str,
    endpoint_url: Optional[str] = None,
    timeout: float = 4.0,
) -> Dict[str, Any]:
    """Sends a payload to the zn cloud gate (stdlib urllib). Secrets are always redacted first."""
    endpoint = endpoint_url or DEFAULT_ENDPOINT
    redacted, _ = redact_secrets(input_text)
    payload = json.dumps({"input": redacted}).encode("utf-8")
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
    timeout: float = 4.0,
    local_only: bool = False,
    **kwargs: Any,
) -> Dict[str, Any]:
    """
    Prompt analysis. Local deterministic rules first; if they block, return at once.
    Only if the user opted in (ZN_API_KEY + ZN_CLOUD=1) is the text, with secrets
    redacted locally, also sent to the zn cloud gate. Otherwise nothing leaves the machine.
    """
    key = api_key or os.environ.get("ZN_API_KEY")

    # 1. Local fast-path (<10µs, $0 cost)
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
        _, detections = redact_secrets(input_text)
        cloud_res = analyze_cloud(input_text, key, target_url, timeout=timeout)
        cloud_res["mode"] = "hybrid-cloud"
        cloud_res["secrets_redacted_before_upload"] = len(detections)
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
