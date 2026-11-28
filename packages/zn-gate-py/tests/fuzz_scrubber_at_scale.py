"""Large seeded fuzz of the Node.js and Python secret scrubbers on split fake keys.

  python3 -m tests.fuzz_scrubber_at_scale --seed split-keys --per-provider 300 --out failures.json

Run from packages/zn-gate-py. Prints counts per provider (cases, remnants, mismatches, crashes) and
writes every failure (with its case seed) to --out. Fake keys only; nothing is printed that is a key.
"""

import argparse
import json
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

from zn_gate.rules import redact_secrets

from . import scrub_fuzz_gen as G

NODE_PKG = Path(__file__).resolve().parents[2] / "zn-gate"
DRIVER = NODE_PKG / "test" / "helpers" / "export_redaction_safe.js"


def node_batch(texts):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf8") as f:
        json.dump(texts, f)
        name = f.name
    try:
        res = subprocess.run(["node", str(DRIVER), name], capture_output=True, text=True, timeout=900, check=True)
    finally:
        Path(name).unlink(missing_ok=True)
    return json.loads(res.stdout)


def py_one(text):
    try:
        return {"out": redact_secrets(text)[0]}
    except Exception as e:  # noqa: BLE001 - a crash is a finding
        return {"error": type(e).__name__ + ": " + str(e)[:200]}


def run(case_list):
    nres = node_batch([c["text"] for c in case_list])
    found = []
    for c, n in zip(case_list, nres, strict=True):
        p = py_one(c["text"])
        kinds = []
        if "error" in n:
            kinds.append("crash_node")
        if "error" in p:
            kinds.append("crash_python")
        if "out" in n:
            rn = G.remnant(c, n["out"])
            if rn:
                kinds.append("remnant_node")
        if "out" in p:
            rp = G.remnant(c, p["out"])
            if rp:
                kinds.append("remnant_python")
        if "out" in n and "out" in p and n["out"] != p["out"]:
            kinds.append("mismatch")
        if kinds:
            found.append({"kinds": kinds, "case": c, "node": n, "python": p})
    return found


SEP_FAMILY = {
    "none": "unsplit", "lf": "newline", "crlf": "newline", "lf_indent": "newline", "space_lf": "newline",
    "tab": "unicode_space", "nbsp": "unicode_space", "u2028": "unicode_space", "u2029": "unicode_space",
    "dq_lf": "quote_split", "sq_lf": "quote_split", "dq_plus": "quote_split",
    "esc_n": "escaped_break", "backslash_lf": "escaped_break", "zwsp": "zero_width",
}
ABSORB = {"openai_hex", "openai_legacy", "github_token"}


def classify(c, node_out, py_out):
    """Failure classes of one case: remnant_<separator family> and, for a mismatch, mismatch_<kind>."""
    out = []
    if G.remnant(c, node_out) or G.remnant(c, py_out):
        out.append("remnant_" + SEP_FAMILY[c["sep"]])
    if node_out != py_out:
        i = 0
        while i < min(len(node_out), len(py_out)) and node_out[i] == py_out[i]:
            i += 1
        if c["provider"] in ABSORB:
            out.append("mismatch_next_line_absorbed")
        elif node_out[i:i + 1] == "-" and py_out[i:i + 1] != "-":
            out.append("mismatch_trailing_dash")
        else:
            out.append("mismatch_other")
    return out


def minimize(failure):
    """The shortest variant (bare context, fewest pieces) of a failing case that fails in the same class."""
    c = failure["case"]
    want = classify(c, failure["node"]["out"], failure["python"]["out"])
    variants = []
    for ctx in ("bare", c["ctx"]):
        pre, post = G.CONTEXTS[ctx]
        for w in range(80, 7, -1):
            v = dict(c, ctx=ctx, width=w)
            v["text"] = pre + G.KEEP.get(c["provider"], "") + G.wrap(c["key"], w, G.SEPARATORS[c["sep"]]) + post
            variants.append(v)
    nres = node_batch([v["text"] for v in variants])
    best = None
    for v, n in zip(variants, nres, strict=True):
        p = py_one(v["text"])
        if "out" not in n or "out" not in p:
            continue
        if classify(v, n["out"], p["out"]) == want:
            if best is None or len(v["text"]) < len(best[0]["text"]):
                best = (v, n["out"], p["out"])
    if best is None:
        return failure["case"], want, failure["node"]["out"], failure["python"]["out"]
    return best[0], want, best[1], best[2]


def pieces(s, n=5):
    return [s[i:i + n] for i in range(0, len(s), n)]


def build_corpus(found):
    """One minimal case per (class, provider), in a stable order."""
    pick = {}
    for f in found:
        n, p = f["node"].get("out"), f["python"].get("out")
        if n is None or p is None:
            continue
        for cls in classify(f["case"], n, p):
            k = (cls, f["case"]["provider"])
            if k not in pick or len(f["case"]["text"]) < len(pick[k]["case"]["text"]):
                pick[k] = f
    corpus = []
    for (cls, prov), f in sorted(pick.items()):
        v, want, n_out, p_out = minimize(f)
        if cls not in want:
            continue
        corpus.append({
            "id": "fuzz-%s-%s" % (cls, prov), "class": cls, "seed": v["seed"], "provider": prov,
            "sep": v["sep"], "ctx": v["ctx"], "width": v["width"],
            # Stored in pieces of 5 characters so that no complete fake key sits in the file
            # (secret scanners flag whole key shapes, even obvious fakes). Join them to read a case.
            "text_parts": pieces(v["text"]), "secret_parts": pieces(v["key"][v["body_off"]:]),
            "node_remnant": bool(G.remnant(v, n_out)), "python_remnant": bool(G.remnant(v, p_out)),
            "mismatch": n_out != p_out,
        })
    return corpus


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus-out", help="also write the minimised corpus of failure classes to this file")
    ap.add_argument("--seed", default="split-keys")
    ap.add_argument("--per-provider", type=int, default=100)
    ap.add_argument("--out", default="failures.json")
    a = ap.parse_args()
    case_list = list(G.cases(a.seed, a.per_provider))
    found = run(case_list)
    total = Counter(c["provider"] for c in case_list)
    per = defaultdict(Counter)
    for f in found:
        for k in f["kinds"]:
            per[f["case"]["provider"]][k] += 1
    print("seed=%s cases=%d failing=%d" % (a.seed, len(case_list), len(found)))
    tot = Counter()
    for name in G.PROVIDER_NAMES:
        c = per[name]
        tot.update(c)
        print("%-22s cases=%4d remnant_node=%4d remnant_py=%4d mismatch=%4d crash_node=%d crash_py=%d" % (
            name, total[name], c["remnant_node"], c["remnant_python"], c["mismatch"], c["crash_node"], c["crash_python"]))
    print("TOTAL", dict(tot))
    by_sep = Counter((f["case"]["sep"]) for f in found)
    print("by separator:", dict(sorted(by_sep.items())))
    by_ctx = Counter((f["case"]["ctx"]) for f in found)
    print("by context:", dict(sorted(by_ctx.items())))
    cls_count = Counter()
    for f in found:
        if "out" in f["node"] and "out" in f["python"]:
            cls_count.update(classify(f["case"], f["node"]["out"], f["python"]["out"]))
    print("by class:", dict(sorted(cls_count.items())))
    Path(a.out).write_text(json.dumps(found), encoding="utf8")
    if a.corpus_out:
        corpus = build_corpus(found)
        Path(a.corpus_out).write_text(json.dumps(corpus, indent=0, sort_keys=True) + "\n", encoding="utf8")
        print("corpus cases:", len(corpus), Counter(c["class"] for c in corpus))


if __name__ == "__main__":
    sys.exit(main())
