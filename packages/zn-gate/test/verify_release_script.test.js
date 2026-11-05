'use strict';
// Tests for scripts/verify-release.sh (the one-command check of a published release).
// The script runs with a PATH that holds only symlinks to a few system tools and FAKE
// executables (gh, npm, sha256sum, cosign, pypi-attestations) that log every call to a file
// and fail when a test tells them to. Nothing here touches the network.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = process.env.VERIFY_RELEASE_SCRIPT ||
  path.resolve(__dirname, '..', '..', '..', 'scripts', 'verify-release.sh');
const skip = process.platform === 'win32' ? 'the script needs a POSIX shell' : false;

const SYSTEM_TOOLS = ['bash', 'mktemp', 'rm', 'ls', 'awk', 'grep', 'sed', 'tail', 'mkdir', 'cat', 'tr'];

function findSystemTool(name) {
  for (const dir of ['/usr/bin', '/bin']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error('system tool not found: ' + name);
}

const FAKES = {
  gh: `#!/bin/bash
echo "gh $*" >> "$FAKE_LOG"
case "$1 $2" in
  "release download")
    dir=""
    while [ $# -gt 0 ]; do [ "$1" = "--dir" ] && dir="$2"; shift; done
    case ",$FAKE_FAIL," in *,download,*) echo "network down" >&2; exit 1;; esac
    echo "$dir" >> "$FAKE_MARK"
    : > "$dir/zn-gate-$FAKE_VERSION.tgz"
    : > "$dir/zn_gate-$FAKE_PYVERSION.tar.gz"
    : > "$dir/zn_gate-$FAKE_PYVERSION-py3-none-any.whl"
    : > "$dir/SHA256SUMS.sigstore.json"
    case ",$FAKE_FAIL," in *,nosums,*) : > "$dir/SHA256SUMS";; *)
      { echo "aa  zn-gate-$FAKE_VERSION.tgz"; echo "bb  zn_gate-$FAKE_PYVERSION.tar.gz"; echo "cc  zn_gate-$FAKE_PYVERSION-py3-none-any.whl"; } > "$dir/SHA256SUMS";;
    esac
    exit 0;;
  "attestation verify")
    case ",$FAKE_FAIL," in *,attest,*) echo "no matching attestation" >&2; exit 1;; esac
    exit 0;;
esac
exit 0
`,
  sha256sum: `#!/bin/bash
echo "sha256sum $*" >> "$FAKE_LOG"
case ",$FAKE_FAIL," in *,sums,*) echo "FAILED" >&2; exit 1;; esac
exit 0
`,
  cosign: `#!/bin/bash
echo "cosign $*" >> "$FAKE_LOG"
case ",$FAKE_FAIL," in *,sig,*) echo "bad signature" >&2; exit 1;; esac
exit 0
`,
  'pypi-attestations': `#!/bin/bash
echo "pypi-attestations $*" >> "$FAKE_LOG"
case ",$FAKE_FAIL," in *,pypi,*) echo "no attestation" >&2; exit 1;; esac
exit 0
`,
  npm: `#!/bin/bash
echo "npm $*" >> "$FAKE_LOG"
case "$1" in
  install)
    case ",$FAKE_FAIL," in *,npm_install,*) exit 1;; esac
    v="$FAKE_VERSION"
    case ",$FAKE_FAIL," in *,npm_version,*) v="0.0.1";; esac
    mkdir -p node_modules/zn-gate
    printf '{\\n  "name": "zn-gate",\\n  "version": "%s"\\n}\\n' "$v" > node_modules/zn-gate/package.json
    exit 0;;
  audit)
    case ",$FAKE_FAIL," in *,npm_audit,*) echo "invalid signature" >&2; exit 1;; esac
    exit 0;;
  view)
    case ",$FAKE_FAIL," in *,npm_att,*) exit 0;; esac
    echo "{ url: 'https://registry.npmjs.org/-/npm/v1/attestations/zn-gate@$FAKE_VERSION' }"
    exit 0;;
esac
exit 0
`,
};

// Runs the script. opts: version, fail (list), omit (list of fake tools left out).
function run(args, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-vrs-'));
  const bin = path.join(root, 'bin');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(bin);
  fs.mkdirSync(tmp);
  for (const t of SYSTEM_TOOLS) fs.symlinkSync(findSystemTool(t), path.join(bin, t));
  const omit = new Set(opts.omit || []);
  for (const [name, body] of Object.entries(FAKES)) {
    if (omit.has(name)) continue;
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }
  const log = path.join(root, 'calls.log');
  const mark = path.join(root, 'download-dirs.log');
  fs.writeFileSync(log, '');
  fs.writeFileSync(mark, '');
  const version = opts.fakeVersion || '1.14.1';
  const env = {
    PATH: bin,
    TMPDIR: tmp,
    FAKE_LOG: log,
    FAKE_MARK: mark,
    FAKE_FAIL: (opts.fail || []).join(','),
    FAKE_VERSION: version,
    FAKE_PYVERSION: opts.fakePy || version,
  };
  const r = spawnSync(findSystemTool('bash'), [SCRIPT, ...args], { env, encoding: 'utf8', timeout: 30000 });
  const result = {
    status: r.status,
    out: (r.stdout || '') + (r.stderr || ''),
    calls: fs.readFileSync(log, 'utf8'),
    dirs: fs.readFileSync(mark, 'utf8').split('\n').filter(Boolean),
    tmpLeft: fs.readdirSync(tmp),
    root,
  };
  return result;
}

function cleanup(r) {
  fs.rmSync(r.root, { recursive: true, force: true });
}

test('all five steps pass: exit 0 and the final line', { skip }, () => {
  const r = run(['1.14.1']);
  try {
    assert.strictEqual(r.status, 0, r.out);
    for (const n of ['1/5', '2/5', '3/5', '4/5', '5/5']) {
      assert.match(r.out, new RegExp('\\[' + n + '\\][^\\n]* \\.\\.\\. PASS'), r.out);
    }
    const last = r.out.trim().split('\n').pop();
    assert.match(last, /^VERIFIED: zn-gate 1\.14\.1: all 5 checks passed\./);
    assert.match(last, /docs\/verify-release\.md/);
    assert.match(last, /does not show the source or the build pipeline was free of mistakes/);
    assert.doesNotMatch(r.out, /FAIL|CANNOT CHECK|NOT VERIFIED/);
  } finally { cleanup(r); }
});

test('the signer workflow, identity, tag and PyPI version follow the release', { skip }, () => {
  let r = run(['1.12.0'], { fakeVersion: '1.12.0' });
  try {
    assert.strictEqual(r.status, 0, r.out);
    assert.match(r.calls, /--signer-workflow usezn\/zn\/\.github\/workflows\/build-release\.yml --source-ref refs\/tags\/v1\.12\.0/);
    assert.match(r.calls, /--certificate-identity https:\/\/github\.com\/usezn\/zn\/\.github\/workflows\/build-release\.yml@refs\/tags\/v1\.12\.0 /);
    assert.match(r.calls, /--certificate-oidc-issuer https:\/\/token\.actions\.githubusercontent\.com/);
  } finally { cleanup(r); }
  r = run(['1.11.0'], { fakeVersion: '1.11.0' });
  try {
    assert.strictEqual(r.status, 0, r.out);
    assert.match(r.calls, /--signer-workflow usezn\/zn\/\.github\/workflows\/release\.yml --source-ref refs\/tags\/v1\.11\.0/);
    assert.doesNotMatch(r.calls, /build-release\.yml/);
  } finally { cleanup(r); }
  r = run(['1.15.0-beta.2'], { fakePy: '1.15.0b2', fakeVersion: '1.15.0-beta.2' });
  try {
    assert.strictEqual(r.status, 0, r.out);
    assert.match(r.calls, /pypi:zn_gate-1\.15\.0b2-py3-none-any\.whl/);
    assert.match(r.calls, /pypi:zn_gate-1\.15\.0b2\.tar\.gz/);
    assert.match(r.calls, /zn-gate@1\.15\.0-beta\.2/);
  } finally { cleanup(r); }
  r = run(['1.15.0-rc.1'], { fakePy: '1.15.0rc1', fakeVersion: '1.15.0-rc.1' });
  try {
    assert.strictEqual(r.status, 0, r.out);
    assert.match(r.calls, /pypi:zn_gate-1\.15\.0rc1\.tar\.gz/);
  } finally { cleanup(r); }
});

const STEP_FAILURES = [
  ['1/5', 'sums'],
  ['2/5', 'attest'],
  ['3/5', 'sig'],
  ['4/5', 'npm_audit'],
  ['4/5', 'npm_att'],
  ['4/5', 'npm_install'],
  ['4/5', 'npm_version'],
  ['5/5', 'pypi'],
];
for (const [step, fail] of STEP_FAILURES) {
  test('step ' + step + ' fails (' + fail + '): non-zero, FAIL line, not verified', { skip }, () => {
    const r = run(['1.14.1'], { fail: [fail] });
    try {
      assert.notStrictEqual(r.status, 0, r.out);
      assert.match(r.out, new RegExp('\\[' + step + '\\][^\\n]* \\.\\.\\. FAIL'), r.out);
      assert.match(r.out, /NOT VERIFIED: zn-gate 1\.14\.1: 4 passed, 1 failed, 0 could not be checked/);
      assert.doesNotMatch(r.out, /^VERIFIED/m);
      // The other four steps still ran and passed.
      assert.strictEqual((r.out.match(/\.\.\. PASS/g) || []).length, 4, r.out);
    } finally { cleanup(r); }
  });
}

test('a failed download and a SHA256SUMS without the files are failures', { skip }, () => {
  let r = run(['1.14.1'], { fail: ['download'] });
  try {
    assert.notStrictEqual(r.status, 0, r.out);
    assert.match(r.out, /\[1\/5\][^\n]* FAIL \(could not download/);
    assert.match(r.out, /\[2\/5\][^\n]* FAIL/);
    assert.match(r.out, /\[3\/5\][^\n]* FAIL/);
    assert.doesNotMatch(r.out, /^VERIFIED/m);
  } finally { cleanup(r); }
  r = run(['1.14.1'], { fail: ['nosums'] });
  try {
    assert.notStrictEqual(r.status, 0, r.out);
    assert.match(r.out, /\[1\/5\][^\n]* FAIL \(release files or SHA256SUMS entries are missing/);
  } finally { cleanup(r); }
});

const MISSING = [
  [['gh'], ['1/5', '2/5', '3/5'], 'gh missing'],
  [['npm'], ['4/5'], 'npm missing'],
  [['sha256sum'], ['1/5'], 'sha256sum or shasum missing'],
  [['cosign'], ['3/5'], 'cosign and sigstore-python missing'],
  [['pypi-attestations'], ['5/5'], 'pypi-attestations missing'],
];
for (const [omit, steps, why] of MISSING) {
  test('tool missing (' + omit.join(',') + '): CANNOT CHECK, non-zero, never "skipped"', { skip }, () => {
    const r = run(['1.14.1'], { omit });
    try {
      assert.notStrictEqual(r.status, 0, r.out);
      for (const s of steps) {
        assert.match(r.out, new RegExp('\\[' + s + '\\][^\\n]* CANNOT CHECK \\(' + why + '\\): NOT VERIFIED'), r.out);
      }
      assert.match(r.out, /^NOT VERIFIED: /m);
      assert.doesNotMatch(r.out, /^VERIFIED/m);
      assert.doesNotMatch(r.out, /skip/i);
    } finally { cleanup(r); }
  });
}

const BAD_VERSIONS = [
  '1.2', '1.2.3; rm -rf /', '$(id)', '`id`', '', '1.2.3 ', ' 1.2.3', '1.2.3\n', '../../x', '1.2.3/../x',
  '1.2.3-', '1.2.3-a b', '01.14.1', '1.014.1', '1.14.01', 'v1.14.1', '1.2.3-evil;x', '1.2.3-gamma.1',
  '1.4.0', '1.5.0-beta.1', '1.5.0-alpha.3', '0.9.0', '9999999.0.0',
];
for (const v of BAD_VERSIONS) {
  test('bad version ' + JSON.stringify(v) + ': refused before any command runs', { skip }, () => {
    const r = run([v]);
    try {
      assert.notStrictEqual(r.status, 0, r.out);
      assert.strictEqual(r.calls, '', 'a tool was called: ' + r.calls);
      assert.strictEqual(r.dirs.length, 0);
      assert.deepStrictEqual(r.tmpLeft, []);
      assert.doesNotMatch(r.out, /^VERIFIED/m);
    } finally { cleanup(r); }
  });
}

test('no version, two versions and unknown options are refused before any command runs', { skip }, () => {
  for (const args of [[], ['1.14.1', '1.14.0'], ['--allow-missing', 'npm', '1.14.1'], ['--bogus', '1.14.1'], ['--keep']]) {
    const r = run(args);
    try {
      assert.strictEqual(r.status, 2, args.join(' ') + '\n' + r.out);
      assert.strictEqual(r.calls, '');
    } finally { cleanup(r); }
  }
});

test('--print runs no tool, creates no directory and exits 0', { skip }, () => {
  const r = run(['--print', '1.14.1']);
  try {
    assert.strictEqual(r.status, 0, r.out);
    assert.strictEqual(r.calls, '');
    assert.deepStrictEqual(r.tmpLeft, []);
    assert.match(r.out, /\$ gh release download v1\.14\.1 --repo usezn\/zn/);
    assert.match(r.out, /\$ gh attestation verify .* --repo usezn\/zn --signer-workflow usezn\/zn\/\.github\/workflows\/build-release\.yml --source-ref refs\/tags\/v1\.14\.1/);
    assert.match(r.out, /\$ npm audit signatures/);
    assert.match(r.out, /pypi-attestations verify pypi --repository https:\/\/github\.com\/usezn\/zn pypi:zn_gate-1\.14\.1-py3-none-any\.whl/);
    assert.match(r.out, /Nothing was run/);
    assert.doesNotMatch(r.out, /^VERIFIED/m);
  } finally { cleanup(r); }
  // --print also works with no tool installed at all, and still validates the version.
  const none = run(['--print', '1.14.1'], { omit: Object.keys(FAKES) });
  try { assert.strictEqual(none.status, 0, none.out); } finally { cleanup(none); }
  const bad = run(['--print', '1.2.3; id']);
  try { assert.notStrictEqual(bad.status, 0); assert.strictEqual(bad.calls, ''); } finally { cleanup(bad); }
});

test('-h prints the usage and runs nothing', { skip }, () => {
  const r = run(['-h']);
  try {
    assert.strictEqual(r.status, 0);
    assert.match(r.out, /^Usage: verify-release\.sh/);
    assert.strictEqual(r.calls, '');
    assert.doesNotMatch(r.out, /allow-missing/);
  } finally { cleanup(r); }
});

test('the temporary download directory is removed after a run (pass or fail)', { skip }, () => {
  for (const fail of [[], ['sums'], ['download']]) {
    const r = run(['1.14.1'], { fail });
    try {
      if (!fail.includes('download')) {
        assert.strictEqual(r.dirs.length, 1, 'fake gh did not record the directory');
        assert.ok(r.dirs[0].startsWith(path.join(r.root, 'tmp') + path.sep), r.dirs[0]);
        assert.strictEqual(fs.existsSync(r.dirs[0]), false, 'download directory still exists: ' + r.dirs[0]);
      }
      assert.deepStrictEqual(r.tmpLeft, [], 'left in TMPDIR: ' + r.tmpLeft);
    } finally { cleanup(r); }
  }
});

test('--keep keeps the files, refuses a non-empty directory and writes nowhere else', { skip }, () => {
  const keepRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-vrs-keep-'));
  try {
    const dir = path.join(keepRoot, 'files');
    const r = run(['--keep', dir, '1.14.1']);
    try {
      assert.strictEqual(r.status, 0, r.out);
      assert.ok(fs.existsSync(path.join(dir, 'SHA256SUMS')));
      assert.ok(fs.existsSync(path.join(dir, 'zn-gate-1.14.1.tgz')));
      assert.deepStrictEqual(r.tmpLeft, []);
    } finally { cleanup(r); }
    const again = run(['--keep', dir, '1.14.1']);
    try {
      assert.strictEqual(again.status, 2, again.out);
      assert.strictEqual(again.calls, '');
    } finally { cleanup(again); }
  } finally { fs.rmSync(keepRoot, { recursive: true, force: true }); }
});

test('the script has no eval, no pipe to a shell and no --allow-missing', { skip }, () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /\beval\b/);
  assert.doesNotMatch(code, /\|\s*(ba|z)?sh\b/);
  assert.doesNotMatch(code, /\bcurl\b|\bwget\b/);
  assert.doesNotMatch(code, /allow-missing/);
  assert.match(text, /^set -euo pipefail$/m);
});
