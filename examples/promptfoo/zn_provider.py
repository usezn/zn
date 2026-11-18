"""Promptfoo loads a Python provider from a file, so this one-line file hands it zn-gate's provider."""
from zn_gate.integrations import call_api

__all__ = ["call_api"]
