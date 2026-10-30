"""Every module in src/zn_gate must parse with the declared minimum Python."""
import ast
import os
import unittest

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'zn_gate')
MIN_VERSION = (3, 10)


def _modules():
    for root, _dirs, files in os.walk(SRC):
        for name in sorted(files):
            if name.endswith('.py'):
                yield os.path.join(root, name)


class TestMinPythonSyntax(unittest.TestCase):
    def test_modules_found(self):
        self.assertGreater(len(list(_modules())), 5)

    def test_all_modules_parse_as_min_version(self):
        for path in _modules():
            with self.subTest(module=os.path.relpath(path, SRC)):
                with open(path, encoding='utf-8') as fh:
                    source = fh.read()
                try:
                    ast.parse(source, filename=path, feature_version=MIN_VERSION)
                except SyntaxError as exc:
                    self.fail(f'{path} needs newer than Python {MIN_VERSION}: {exc}')


if __name__ == '__main__':
    unittest.main()
