"""Guard against test functions that pytest would silently never collect.

Fails when a test module defines a ``def test_*`` inside a module-level ``if``
block (for example under ``if __name__ == "__main__":``) or after a
module-level ``unittest.main()`` call.
"""
import ast
import pathlib
import unittest

TESTS_DIR = pathlib.Path(__file__).parent


def _is_unittest_main(node):
    return (
        isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Call)
        and isinstance(node.value.func, ast.Attribute)
        and node.value.func.attr == "main"
        and isinstance(node.value.func.value, ast.Name)
        and node.value.func.value.id == "unittest"
    )


def _is_main_guard(node):
    return (
        isinstance(node, ast.If)
        and isinstance(node.test, ast.Compare)
        and isinstance(node.test.left, ast.Name)
        and node.test.left.id == "__name__"
    )


def find_uncollectable(source, filename="<test>"):
    """Return a list of problems found in one test module's source."""
    problems = []
    tree = ast.parse(source, filename)
    seen_main_call = False
    for node in tree.body:
        if _is_unittest_main(node) or (
            _is_main_guard(node) and any(_is_unittest_main(n) for n in node.body)
        ):
            if not _is_main_guard(node):
                seen_main_call = True
        if isinstance(node, (ast.If, ast.Try, ast.With, ast.For, ast.While)):
            for sub in ast.walk(node):
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)) and sub.name.startswith("test"):
                    problems.append(
                        f"{filename}:{sub.lineno}: {sub.name} is inside a module-level block and is never collected"
                    )
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and seen_main_call and node.name.startswith("test"):
            problems.append(f"{filename}:{node.lineno}: {node.name} comes after unittest.main()")
    return problems


class TestAllTestsAreCollectable(unittest.TestCase):
    def test_no_uncollectable_tests(self):
        problems = []
        for path in sorted(TESTS_DIR.rglob("test_*.py")):
            problems += find_uncollectable(path.read_text(encoding="utf-8"), str(path.relative_to(TESTS_DIR)))
        self.assertEqual(problems, [])

    def test_detector_catches_known_bad_patterns(self):
        bad = 'if __name__ == "__main__":\n    unittest.main()\n    def test_x(self):\n        pass\n'
        self.assertTrue(find_uncollectable(bad))
        after = "import unittest\nunittest.main()\ndef test_y():\n    pass\n"
        self.assertTrue(find_uncollectable(after))
        good = 'class T:\n    def test_a(self):\n        pass\n\nif __name__ == "__main__":\n    unittest.main()\n'
        self.assertEqual(find_uncollectable(good), [])


if __name__ == "__main__":
    unittest.main()
