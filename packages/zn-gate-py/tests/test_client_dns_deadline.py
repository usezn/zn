"""
The cloud client's name lookup ends within the configured timeout, also when the
system resolver would take 20 s. The lookup is simulated; no real name is resolved.
"""

import socket
import subprocess
import sys
import textwrap
import time
import unittest
from unittest import mock

from zn_gate import client


class TestBoundedLookup(unittest.TestCase):
    def test_normal_resolution(self):
        infos = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.0.2.7", 443))]
        with mock.patch.object(client.socket, "getaddrinfo", return_value=infos):
            self.assertEqual(client._bounded_getaddrinfo("api.example.com", 443, 1.0), infos)

    def test_resolution_error_is_passed_on(self):
        with mock.patch.object(client.socket, "getaddrinfo", side_effect=socket.gaierror(-2, "not known")):
            with self.assertRaises(socket.gaierror):
                client._bounded_getaddrinfo("api.example.com", 443, 1.0)

    def test_slow_lookup_times_out_on_time(self):
        def slow(*_a, **_k):
            time.sleep(20)

        with mock.patch.object(client.socket, "getaddrinfo", slow):
            t0 = time.monotonic()
            with self.assertRaises(TimeoutError):
                client._create_connection(("api.example.com", 443), 0.3)
            self.assertLess(time.monotonic() - t0, 1.5)

    def test_connection_uses_resolved_address_and_keeps_host_name(self):
        infos = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.0.2.7", 443))]
        fake = mock.MagicMock()
        with mock.patch.object(client.socket, "getaddrinfo", return_value=infos), \
                mock.patch.object(client.socket, "socket", return_value=fake):
            conn = client._BoundedHTTPSConnection("api.example.com", timeout=2)
            sock = conn._create_connection((conn.host, conn.port), conn.timeout, None)
        self.assertIs(sock, fake)
        fake.connect.assert_called_once_with(("192.0.2.7", 443))
        self.assertEqual(conn.host, "api.example.com")

    def test_hung_lookup_does_not_keep_the_process_alive(self):
        code = textwrap.dedent("""
            import socket, time
            from zn_gate import client
            socket.getaddrinfo = lambda *a, **k: time.sleep(20)
            try:
                client._create_connection(("api.example.com", 443), 0.3)
            except TimeoutError:
                print("timeout")
        """)
        t0 = time.monotonic()
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=15)
        self.assertEqual(out.stdout.strip(), "timeout")
        self.assertLess(time.monotonic() - t0, 5)

    def test_analyze_reports_a_lookup_timeout_as_a_fallback(self):
        def slow(*_a, **_k):
            time.sleep(20)

        with mock.patch.object(client.socket, "getaddrinfo", slow), \
                mock.patch.dict("os.environ", {"ZN_CLOUD": "1"}):
            t0 = time.monotonic()
            res =client.analyze("hello there", api_key="zn_" + "0" * 48, endpoint="https://api.example.com/v30/analyze",
                                 timeout=0.4)
            self.assertLess(time.monotonic() - t0, 2.0)
        self.assertEqual(res["mode"], "oss-local-fallback")


if __name__ == "__main__":
    unittest.main()
