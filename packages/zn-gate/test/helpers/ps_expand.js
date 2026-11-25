'use strict';
// Test helper: the Windows hook scripts hold their answer text once (in $zr) and the node and runner paths once ($zn, $zj), so
// they fit the 8191-character command line. This puts the paths and the first answer text back where a reader expects them, so
// a test can check the steps of the script as text. The .NET profiler check (`if ($env:COR_ENABLE_PROFILING -eq '1') ...`) and the
// line that swaps in the crash text are dropped; tests of those read the script itself (hooks_windows_profiler.test.js).
function expandPs(script) {
  let s = String(script);
  const zp = /\$zn='([^']+)'; \$zj='([^']+)'; /.exec(s);
  if (zp) {
    const [, n, r] = zp;
    s = s.replace(zp[0], '')
      .replace('if (!$zt -and [System.IO.File]::Exists($zn) -and [System.IO.File]::Exists($zj))', "if ([System.IO.File]::Exists('" + n + "') -and [System.IO.File]::Exists('" + r + "'))")
      .replace(/& \$zn \$zj ([a-z-]+); /, (m0, a) => "& '" + n + "' '" + r + "' " + a + '; ')
      .replace(/zr \('"' \+ \$zn \+ '"'\) \('"' \+ \$zj \+ '" ([a-z-]+)'\)/, (m0, a) => "zr '\"" + n + "\"' '\"" + r + "\" " + a + "'");
  }
  const zr = /\$zr='([^']*)'; if \(\$env:COR_ENABLE_PROFILING -eq '1'\) \{ \$zt=9; \$zr='[^']*' \}; /.exec(s);
  if (zr) {
    s = s.replace(zr[0], '').replace(/if \(\$zt -eq 1\) \{ \$zr='[^']*' \}; /, '')
      .split("' + $zr + '").join(zr[1]).split('($zr)').join("('" + zr[1] + "')");
  }
  return s;
}

module.exports = { expandPs };
