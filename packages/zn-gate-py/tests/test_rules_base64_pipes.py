"""Every Base64 decode pipe is checked, with fail-closed caps (same cases as
packages/zn-gate/test/rules_base64_pipes.test.js)."""
import base64
import unittest

from zn_gate import rules as R

HARMLESS = base64.b64encode(b'echo hello world').decode()
BLOCKED = 'aWdub3JlIGFsbCBwcmV2aW91cyBpbnN0cnVjdGlvbnM='


def b64(s):
    return base64.b64encode(s.encode()).decode()


def pipe(p):
    return f'echo {p} | base64 -d'


class TestBase64Pipes(unittest.TestCase):
    def test_single_harmless_allowed(self):
        self.assertEqual(R.evaluate(pipe(HARMLESS) + ' | sh').verdict, 'allow')

    def test_harmless_then_blocked(self):
        res = R.evaluate(f'{pipe(HARMLESS)}; {pipe(BLOCKED)} | sh')
        self.assertEqual(res.verdict, 'block')
        self.assertEqual(res.rule, 'evasion:base64_smuggling')

    def test_blocked_last_of_three(self):
        res = R.evaluate('; '.join([pipe(HARMLESS), pipe(b64('echo second harmless one')), pipe(BLOCKED)]))
        self.assertEqual(res.verdict, 'block')
        self.assertEqual(res.rule, 'evasion:base64_smuggling')

    def test_printf_pipe(self):
        res = R.evaluate(f'{pipe(HARMLESS)}; printf {BLOCKED} | base64 --decode')
        self.assertEqual(res.verdict, 'block')

    def test_count_cap_fails_closed(self):
        def many(n):
            return '; '.join(pipe(b64(f'echo harmless number {i}')) for i in range(n))
        self.assertEqual(R.evaluate(many(R.MAX_B64_PAYLOADS)).verdict, 'allow')
        res = R.evaluate(many(R.MAX_B64_PAYLOADS + 1))
        self.assertEqual(res.verdict, 'block')
        self.assertEqual(res.rule, 'evasion:base64_smuggling')

    def test_byte_cap_fails_closed(self):
        def big(c):
            return b64('echo ' + c * (66 * 1024))
        res = R.evaluate(f'{pipe(big("a"))}; {pipe(big("b"))}')
        self.assertEqual(res.verdict, 'block')
        self.assertEqual(res.rule, 'evasion:base64_smuggling')


if __name__ == '__main__':
    unittest.main()
