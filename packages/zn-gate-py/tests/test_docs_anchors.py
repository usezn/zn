"""Every docs link of the form page.md#heading must point to an existing heading."""

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
DOCS = REPO_ROOT / "docs"

LINK_RE = re.compile(r"\]\(([^)\s]*?\.md)#([^)\s]+)\)")
HEADING_RE = re.compile(r"^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$")
FENCE_RE = re.compile(r"^ {0,3}(```|~~~)")


def slugify(heading: str) -> str:
    """GitHub heading slug: lowercase, drop punctuation, spaces to hyphens."""
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", heading)
    text = text.replace("`", "").replace("*", "")
    text = text.strip().lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def anchors_of(text: str) -> set:
    anchors = set()
    seen = {}
    in_fence = False
    for line in text.splitlines():
        if FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = HEADING_RE.match(line)
        if not m:
            continue
        slug = slugify(m.group(2))
        n = seen.get(slug, 0)
        seen[slug] = n + 1
        anchors.add(slug if n == 0 else f"{slug}-{n}")
    return anchors


def collect_links():
    links = []
    for page in sorted(DOCS.glob("*.md")):
        in_fence = False
        for lineno, line in enumerate(page.read_text(encoding="utf-8").splitlines(), 1):
            if FENCE_RE.match(line):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            for m in LINK_RE.finditer(line):
                links.append((page, lineno, m.group(1), m.group(2)))
    return links


def test_slugify_matches_github_format():
    assert slugify("If your agent blocks every prompt") == "if-your-agent-blocks-every-prompt"
    assert slugify("`init`") == "init"
    assert slugify("Exit codes") == "exit-codes"
    assert slugify("Q: What's new?") == "q-whats-new"


def test_anchors_of_handles_duplicates_and_fences(tmp_path):
    text = "# Title\n## Setup\n```\n# not a heading\n```\n## Setup\n"
    assert anchors_of(text) == {"title", "setup", "setup-1"}


def test_docs_contain_anchor_links():
    assert collect_links()


@pytest.mark.parametrize(
    "page,lineno,target,anchor",
    collect_links(),
    ids=lambda v: v.name if isinstance(v, Path) else None,
)
def test_link_anchor_exists(page, lineno, target, anchor):
    path = (page.parent / target).resolve()
    assert path.is_file(), f"{page.name}:{lineno}: {target} does not exist"
    found = anchors_of(path.read_text(encoding="utf-8"))
    assert anchor.lower() in found, f"{page.name}:{lineno}: {target}#{anchor} has no matching heading"
