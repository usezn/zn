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
import http.client
import os
import socket
import threading
import urllib.request
import urllib.error
from typing import Any, Dict, Optional, cast

from .rules import evaluate, redact_secrets
from . import __version__
from .verbose import is_verbose

DEFAULT_ENDPOINT = "https://api.usezn.com/v30/analyze"


# The stdlib's own "no timeout given" marker; typeshed does not declare it.
_DEFAULT_TIMEOUT: Any = socket.__dict__["_GLOBAL_DEFAULT_TIMEOUT"]


def _bounded_getaddrinfo(host: Any, port: Any, timeout: Optional[float]) -> Any:
    """socket.getaddrinfo that gives up after `timeout` seconds.

    getaddrinfo cannot be cancelled and can take about 20 s on a network that silently drops traffic, whatever the
    request timeout says. It runs in a daemon thread, so a lookup still pending never keeps the interpreter alive.
    The system resolver is still what answers: /etc/hosts and split-DNS keep working.
    """
    box: Dict[str, Any] = {}

    def work() -> None:
        try:
            box["result"] = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
        except BaseException as exc:  # handed to the caller below
            box["error"] = exc

    worker = threading.Thread(target=work, name="zn-gate-dns", daemon=True)
    worker.start()
    worker.join(timeout)
    if worker.is_alive():
        raise TimeoutError("timed out resolving %s" % (host,))
    if "error" in box:
        raise cast(BaseException, box["error"])
    return box["result"]


def _create_connection(address: Any, timeout: Any = _DEFAULT_TIMEOUT, source_address: Any = None) -> socket.socket:
    """socket.create_connection with a bounded name lookup (same signature)."""
    host, port = address
    wait = None if timeout is _DEFAULT_TIMEOUT else timeout
    last: Optional[OSError] = None
    for family, kind, proto, _canon, sockaddr in _bounded_getaddrinfo(host, port, wait):
        sock = None
        try:
            sock = socket.socket(family, kind, proto)
            if timeout is not _DEFAULT_TIMEOUT:
                sock.settimeout(timeout)
            if source_address:
                sock.bind(source_address)
            sock.connect(sockaddr)
            return sock
        except OSError as exc:
            last = exc
            if sock is not None:
                sock.close()
    raise last or OSError("getaddrinfo returns an empty list")


class _BoundedHTTPSConnection(http.client.HTTPSConnection):
    # http.client opens the socket through this attribute, then does TLS with the host name (SNI and the
    # certificate check) and sends it as the Host header, so connecting to a resolved address is safe.
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._create_connection = _create_connection


class _BoundedHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req: Any) -> Any:
        return self.do_open(_BoundedHTTPSConnection, req, context=getattr(self, "_context", None))


_OPENER: Optional[urllib.request.OpenerDirector] = None


def _open(req: Any, timeout: Optional[float] = None) -> Any:
    """urlopen with the proxy settings of the environment and a name lookup that ends within `timeout`."""
    global _OPENER
    if _OPENER is None:
        _OPENER = urllib.request.build_opener(_BoundedHTTPSHandler)
    return _OPENER.open(req, timeout=timeout)


def resolve_endpoint(options: Optional[Dict[str, Any]] = None) -> str:
    options = options or {}
    if "api_url" in options and options["api_url"]:
        return cast(str, options["api_url"])
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


# The cloud gate answers "allow" or "block". The verdict is read once here, without case or surrounding spaces,
# so every caller compares a lowercase value; any other verdict (missing, empty, unknown) blocks: fail closed.
# A body that is not a JSON object raises TypeError, a failed cloud call (the local rules decide).
_UNKNOWN_CLOUD_VERDICT: Dict[str, Any] = {
    "verdict": "block",
    "confidence": 1.0,
    "rule": "cloud:unknown-verdict",
    "reason": "The cloud gate answered with a verdict zn does not know, so the text is blocked.",
}


def _cloud_verdict(parsed: Any) -> Dict[str, Any]:
    if not isinstance(parsed, dict):
        raise TypeError("the gateway response is not a JSON object")
    out: Dict[str, Any] = dict(parsed)
    v = out.get("verdict")
    v = v.strip().lower() if isinstance(v, str) else ""
    if v in ("allow", "block"):
        out["verdict"] = v
        return out
    out.update(_UNKNOWN_CLOUD_VERDICT)
    return out


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
    with _open(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
        parsed: Dict[str, Any] = _cloud_verdict(json.loads(raw))
        parsed["engine"] = "cloud-v30" if "/v30" in endpoint else "cloud-prod"
        return parsed


def cloud_error_hint(exc: BaseException) -> str:
    """One plain sentence on what a failed cloud call means and what to do."""
    if isinstance(exc, urllib.error.HTTPError):
        if exc.code in (401, 403):
            return "The cloud service did not accept the API key: check ZN_API_KEY."
        return f"The cloud service answered with an error (HTTP {exc.code}): try again later."
    reason = getattr(exc, "reason", exc)
    if isinstance(exc, TimeoutError) or isinstance(reason, TimeoutError) or "timed out" in str(exc):
        return "The cloud service took too long to answer: check your network connection."
    if isinstance(exc, urllib.error.URLError):
        return "The cloud service could not be reached: check your network connection and ZN_API_URL."
    return "The cloud check failed."


DEGRADED_REASON = "model unavailable, rules only"


def degraded_fields(cloud_res: Dict[str, Any]) -> Dict[str, Any]:
    """When the gate could not reach its model it answers from the rules alone and says so in decided_by ("ml-error...").
    That answer is not a model verdict: it is marked degraded so callers can tell it apart."""
    decided_by = cloud_res.get("decided_by")
    if isinstance(decided_by, str) and decided_by.strip().lower().startswith("ml-error"):
        return {"degraded": True, "degraded_reason": DEGRADED_REASON}
    return {}


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
            **({"advisory": dict(local_eval.advisory)} if local_eval.advisory else {}),
        }

    # 2. Cloud Gate deep neural analysis
    target_url = endpoint or resolve_endpoint(kwargs)
    try:
        sanitized, detections = redact_secrets(input_text)
        # Length in UTF-16 units, as the Node.js client counts it.
        windows = long_input_mode(long_input) == "windows" and len(sanitized.encode("utf-16-le")) // 2 > LONG_INPUT_MIN_CHARS
        cloud_res = analyze_cloud(input_text, key or "", target_url,
                                  timeout=timeout if timeout is not None else (WINDOWS_TIMEOUT if windows else 4.0),
                                  long_input="windows" if windows else None)
        cloud_res["mode"] = "hybrid-cloud"
        cloud_res["secrets_redacted_before_upload"] = len(detections)
        cloud_res.update(degraded_fields(cloud_res))
        li = cloud_res.get("long_input")
        if isinstance(li, dict) and li.get("capped"):
            cloud_res["warning"] = ("The text is longer than the cloud gate checks (%s windows of 512 tokens): "
                                    "the end was not analyzed." % li.get("windows"))
        elif windows and isinstance(li, dict) and li.get("mode") == "truncate":
            cloud_res["warning"] = ("The cloud gate checked only the first 512 tokens of this text (%s)."
                                    % (li.get("reason") or "no windows"))
        return cloud_res
    except Exception as exc:
        if isinstance(exc, urllib.error.HTTPError):
            # An HTTP error carries the open response: close it now instead of leaving the socket to the GC.
            exc.close()
        if is_verbose():
            import sys
            sys.stderr.write(f"[zn-gate] Warning: Cloud gate error ({exc}). {cloud_error_hint(exc)} "
                             "The local rules were used instead, so the text was checked on this machine only.\n")
        return {
            "verdict": "allow",
            "confidence": local_eval.confidence,
            "rule": "none",
            "reason": None,
            "mode": "oss-local-fallback",
            "engine": "oss-local",
            "fallback": True,
            "cloud_error": str(exc),
            **({"advisory": dict(local_eval.advisory)} if local_eval.advisory else {}),
        }
