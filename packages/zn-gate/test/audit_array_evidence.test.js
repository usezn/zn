'use strict';
// `zn audit` hides the value that follows a credential flag inside a JSON or TOML array (MCP server args),
// whatever its format, in the text, JSON and SARIF reports: one-line arrays, single-quoted TOML items and
// pretty-printed arrays with the flag and its value on separate lines.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');
const { redact } = require('../lib/audit');
const { budget } = require('./helpers/time_budget');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const V1 = 'zn-test-fake-value-0000';
const V2 = 'Qx7-fake_ZnTestValue/9aB3';

function cli(args) {
  const env = Object.assign({}, process.env, { NO_COLOR: '1', ZN_LOCAL_ONLY: 'true' });
  return spawnSync(process.execPath, [CLI, 'audit', ...args], { encoding: 'utf8', env });
}

// Each file has a syntax error right after the value, so that the audit reports the line that holds it
// (an unparsable config is reported with its offending line as evidence).
const FORMS = {
  'JSON, one line': `{"mcpServers": {"x": {"command": "npx", "args": ["-y", "pkg", "--api-key", "${V1}" "x"]}}}`,
  'JSON, pretty': `{
  "mcpServers": {
    "x": {
      "command": "npx",
      "args": [
        "-y",
        "--api-key",
        "${V2}" "x"
      ]
    }
  }
}
`,
  'JSON, spaced': `{"mcpServers": {"x": {"command": "npx", "args": [ "--token" ,   "${V2}" "x" ]}}}`,
};
const TOML = {
  'TOML, double quotes': `[mcp_servers.x]
command = "npx"
args = ["-y", "pkg", "--token", "${V1}" "x"]
`,
  'TOML, single quotes': `[mcp_servers.x]
command = 'npx'
args = ['-y', 'pkg', '--token', '${V1}' 'x']
`,
  'TOML, spaces and mixed quotes': `[mcp_servers.x]
command = "npx"
args = [ '--api-key' ,  "${V2}" 'x' ]
`,
  'TOML, multi-line': `[mcp_servers.x]
command = "npx"
args = [
  "-y",
  "pkg",
  '--token',
  '${V2}' 'x',
]
`,
};

test('redact: the value after a credential flag in an array is hidden in every form', () => {
  const lines = [
    `"args": ["--api-key", "${V1}"]`,
    `"args": ["--api-key", "${V2}", "x"]`,
    `args = ['--token', '${V1}']`,
    `args = [ '--token' , '${V1}' ]`,
    `args = ['--api-key', "${V2}"]`,
    `args = ['--auth-token',\n  '${V2}']`,
    `"args": ["--api-key",\n      "${V1}"]`,
  ];
  for (const l of lines) {
    const out = redact(l);
    assert.ok(!out.includes(V1) && !out.includes('ZnTestValue') && !out.includes('fake-value'), 'leaked: ' + out);
    assert.match(out, /\[REDACTED\]/);
  }
});

test('redact: other array items stay readable', () => {
  assert.equal(redact(`args = ['-y', 'pkg@1.0.0', '--port', '8080']`), `args = ['-y', 'pkg@1.0.0', '--port', '8080']`);
});

for (const [name, content] of Object.entries(Object.assign({}, FORMS, TOML))) {
  test('audit reports hide the array credential value: ' + name, (t) => {
    const dir = tempDir(t, 'zn-audit-arr-');
    const file = name.startsWith('TOML') ? '.codex/config.toml' : '.mcp.json';
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
    const json = cli([dir, '--format', 'json', '--fail-on', 'none']);
    const outs = [cli([dir, '--fail-on', 'none']).stdout, json.stdout, cli([dir, '--format', 'sarif', '--fail-on', 'none']).stdout];
    assert.ok(JSON.parse(json.stdout).findings.length > 0, 'the fixture must produce findings');
    for (const out of outs) {
      assert.ok(!out.includes(V1), 'value printed');
      assert.ok(!out.includes(V2), 'value printed');
      assert.ok(!out.includes('ZnTestValue') && !out.includes('fake-value-0000'), 'part of the value printed');
    }
  });
}

/* ---- comments, blank lines, long flag lines and double-escaped quotes between a flag and its value ---- */

const LONG = Array.from({ length: 80 }, (_, i) => `"item-${i}"`).join(', ');
const GAP_FORMS = {
  'JSON, line comment between': `{
  // JSONC
  "mcpServers": { "x": { "command": "npx", "args": [
    "--api-key",
    // the key goes next
    "${V1}" "x"
  ] } }
}
`,
  'JSON, trailing comment on the flag line': `{
  "mcpServers": { "x": { "command": "npx", "args": [
    "--api-key", // note
    "${V1}" "x"
  ] } }
}
`,
  'JSON, three blank lines': `{
  "mcpServers": { "x": { "command": "npx", "args": [
    "--token",



    "${V2}" "x"
  ] } }
}
`,
  'JSON, blank lines and comments mixed': `{
  "mcpServers": { "x": { "command": "npx", "args": [
    "--token",

    // one
    /* two */

    // three
    "${V2}" "x"
  ] } }
}
`,
  'JSON, flag line over 512 characters': `{
  "mcpServers": { "x": { "command": "npx", "args": [
    ${LONG}, "--api-key",
    "${V1}" "x"
  ] } }
}
`,
};
const GAP_TOML = {
  'TOML, comment between': `[mcp_servers.x]
command = "npx"
args = [
  "--token",
  # the key goes next
  "${V1}" "x",
]
`,
  'TOML, trailing comment on the flag line': `[mcp_servers.x]
command = "npx"
args = [
  '--token', # note
  '${V2}' 'x',
]
`,
  'TOML, blank lines and comments': `[mcp_servers.x]
command = "npx"
args = [
  '--api-key',


  # one

  # two
  '${V1}' 'x',
]
`,
};

test('redact: blank lines and long lines between a flag and its value', () => {
  const lines = [
    `"args": ["--api-key",\n\n\n\n\n  "${V1}"]`,
    `"args": [${LONG}, "--api-key",\n  "${V2}"]`,
  ];
  for (const l of lines) {
    const out = redact(l);
    assert.ok(!out.includes(V1) && !out.includes('ZnTestValue') && !out.includes('fake-value'), 'leaked: ' + out.slice(-120));
  }
});

test('redact: double-escaped quotes (JSON inside a JSON string)', () => {
  const lines = [
    String.raw`"cmd": "run \\\"--api-key\\\", \\\"${V1}\\\" x"`,
    String.raw`"cmd": "run \\\"--token\\\",\\\"${V2}\\\""`,
    String.raw`"cmd": "run \"--api-key\", \"${V1}\" x"`,
  ];
  for (const l of lines) {
    const out = redact(l);
    assert.ok(!out.includes(V1) && !out.includes('ZnTestValue') && !out.includes('fake-value'), 'leaked: ' + out);
    assert.match(out, /\[REDACTED\]/);
  }
});

for (const [name, content] of Object.entries(Object.assign({}, GAP_FORMS, GAP_TOML))) {
  test('audit reports hide the value after a gap: ' + name, (t) => {
    const dir = tempDir(t, 'zn-audit-gap-');
    const file = name.startsWith('TOML') ? '.codex/config.toml' : '.mcp.json';
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
    const json = cli([dir, '--format', 'json', '--fail-on', 'none']);
    const outs = [cli([dir, '--fail-on', 'none']).stdout, json.stdout, cli([dir, '--format', 'sarif', '--fail-on', 'none']).stdout];
    assert.ok(JSON.parse(json.stdout).findings.length > 0, 'the fixture must produce findings');
    for (const out of outs) {
      assert.ok(!out.includes(V1), 'value printed');
      assert.ok(!out.includes(V2), 'value printed');
      assert.ok(!out.includes('ZnTestValue') && !out.includes('fake-value-0000'), 'part of the value printed');
    }
  });
}

test('audit keeps visible what is not a credential value', (t) => {
  const cases = [
    ['8080-visible', `{"mcpServers": {"x": {"command": "npx", "args": [\n  "--port", // note\n  "8080-visible" "x"\n]}}}\n`],
    ['8081-visible', `{"mcpServers": {"x": {"command": "npx", "args": [\n  "--verbose",\n\n  "8081-visible" "x"\n]}}}\n`],
    ['ZN_TEST_REF', `{"mcpServers": {"x": {"command": "npx", "args": [\n  "--token", // note\n  "\${ZN_TEST_REF}" "x"\n]}}}\n`],
  ];
  for (const [shown, content] of cases) {
    const dir = tempDir(t, 'zn-audit-benign-');
    fs.writeFileSync(path.join(dir, '.mcp.json'), content);
    const json = cli([dir, '--format', 'json', '--fail-on', 'none']);
    assert.ok(JSON.parse(json.stdout).findings.length > 0, 'the fixture must produce findings');
    const all = json.stdout + cli([dir, '--fail-on', 'none']).stdout;
    assert.ok(all.includes(shown), shown + ' must stay visible');
  }
  assert.equal(redact('"--port", // n\n "8080"'), '"--port", // n\n "8080"');
  assert.equal(redact('"--verbose", # n\n "x"'), '"--verbose", # n\n "x"');
  assert.equal(redact('"--token", # n\n "${ZN_TEST_REF}"'), '"--token", # n\n "${ZN_TEST_REF}"');
});

test('redaction stays linear on adversarial input', () => {
  const BIG = 100 * 1024;
  const cases = {
    'long flag-like line': '"--token", '.repeat(Math.ceil(BIG / 11)) + '\n"x"',
    'many comment lines': '"--token",\n' + '# c\n'.repeat(BIG / 4) + '"x"',
    'many blank lines': '"--token",\n' + '\n'.repeat(BIG) + '"x"',
    'escape runs': '\\'.repeat(BIG) + '"--token",' + '\\'.repeat(BIG) + '"x"',
    'quotes and spaces': '"--token"' + ' '.repeat(BIG) + ',' + ' '.repeat(BIG) + '"x',
    'flag then long comment': '"--token", // ' + 'a '.repeat(BIG / 2) + '\n"x"',
  };
  for (const [name, text] of Object.entries(cases)) {
    const t0 = process.hrtime.bigint();
    redact(text);
    const ms1 = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms1 < budget(2000), `${name}: ${ms1} ms`);
  }
  // the same per line through a whole report
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zn-audit-lin-'));
  try {
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{"mcpServers": {"x": {"args": [\n"--token",\n' + '// c\n'.repeat(BIG / 5) + '"x" "y"]}}}\n');
    const t0 = process.hrtime.bigint();
    cli([dir, '--format', 'json', '--fail-on', 'none']);
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 20000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---- block comments, long comments, deeper escapes, wide gaps and literal \n ---- */

const mcpJson = (items) => `{
  "mcpServers": { "x": { "command": "npx", "args": [
${items}
  ] } }
}
`;
const GAP3 = {
  'JSON, multi-line block comment with star prefix': mcpJson(`    "--api-key",\n    /* first\n     * second\n     */\n    "${V1}" "x"`),
  'JSON, multi-line block comment with plain text': mcpJson(`    "--api-key",\n    /* first\n    plain text\n    */\n    "${V2}" "x"`),
  'JSON, block comment closing after code': mcpJson(`    "--token", /* first\n    plain text */\n    "${V1}" "x"`),
  'JSON, block comment at the end of the flag line': mcpJson(`    "--token", /* note */\n    "${V2}" "x"`),
  'JSON, trailing comment over 1024 characters': mcpJson(`    "--token", // ${'x'.repeat(1500)}\n    "${V1}" "x"`),
  'JSON, line comment inside a block comment gap': mcpJson(`    "--token",\n    /* a */\n    // b\n    /* c\n     * d */\n    "${V2}" "x"`),
};

test('audit reports hide the value after a block comment or a long comment', () => {
  for (const [name, content] of Object.entries(GAP3)) {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zn-audit-gap3-'));
    try {
      fs.writeFileSync(path.join(dir, '.mcp.json'), content);
      const json = cli([dir, '--format', 'json', '--fail-on', 'none']);
      const outs = [cli([dir, '--fail-on', 'none']).stdout, json.stdout, cli([dir, '--format', 'sarif', '--fail-on', 'none']).stdout];
      assert.ok(JSON.parse(json.stdout).findings.length > 0, name + ': the fixture must produce findings');
      for (const out of outs) {
        assert.ok(!out.includes(V1) && !out.includes(V2), name + ': value printed');
        assert.ok(!out.includes('ZnTestValue') && !out.includes('fake-value-0000'), name + ': part of the value printed');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('redact: deeper escapes, wide gaps and a literal backslash-n between the flag and its value', () => {
  const bs = (n) => String.raw`\ `.trim().repeat(n);
  const lines = [
    `"x": "[${bs(5)}"--token${bs(5)}", ${bs(5)}"${V1}${bs(5)}"]"`,
    `"x": "[${bs(7)}"--api-key${bs(7)}",${bs(7)}"${V2}${bs(7)}"]"`,
    `"x": "[${bs(3)}"--token${bs(3)}", ${bs(3)}"Qx${bs(2)}ab${V1}${bs(3)}"]"`,
    `["--token",${' '.repeat(65)}"${V1}"]`,
    `["--token",${' '.repeat(120)}"${V2}"]`,
    `["--token",\n${' '.repeat(100)}\t"${V1}"]`,
    String.raw`"c": "[\n \"--api-key\",\n \"` + V1 + String.raw`\"\n"`,
    String.raw`"c": "[\n \\\"--api-key\\\",\n \\\"` + V2 + String.raw`\\\"\n"`,
    String.raw`"c": "[\"--token\",\r\n\t\"` + V1 + String.raw`\"]"`,
  ];
  for (const l of lines) {
    const out = redact(l);
    assert.ok(!out.includes(V1) && !out.includes('ZnTestValue') && !out.includes('fake-value'), 'leaked: ' + out);
    assert.match(out, /\[REDACTED\]/);
  }
  assert.ok(!redact(`"x": "[${bs(3)}"--token${bs(3)}", ${bs(3)}"Qx${bs(2)}ab${V1}${bs(3)}"]"`).includes('ab'), 'value with a backslash cut short');
});

test('audit keeps visible the next item when a comment mentions a flag', (t) => {
  const dir = tempDir(t, 'zn-audit-gap3-fp-');
  const cases = [
    ['shown-1', `{"mcpServers": {"x": {"command": "npx", "args": [\n  "-y", // "--token",\n  "shown-1" "x"\n]}}}\n`],
    ['shown-2', `{"mcpServers": {"x": {"command": "npx", "args": [\n  "--port", /* a\n   * b */\n  "shown-2" "x"\n]}}}\n`],
    ['shown-3', `{"mcpServers": {"x": {"command": "npx", "args": [\n  "--verbose", /* note */\n  "shown-3" "x"\n]}}}\n`],
    ['ZN_TEST_REF', `{"mcpServers": {"x": {"command": "npx", "args": [\n  "--token",\n  /* a\n   b */\n  "\${ZN_TEST_REF}" "x"\n]}}}\n`],
  ];
  for (const [shown, content] of cases) {
    fs.writeFileSync(path.join(dir, '.mcp.json'), content);
    const json = cli([dir, '--format', 'json', '--fail-on', 'none']);
    assert.ok(JSON.parse(json.stdout).findings.length > 0, 'the fixture must produce findings');
    assert.ok((json.stdout + cli([dir, '--fail-on', 'none']).stdout).includes(shown), shown + ' must stay visible');
  }
});

test('redaction stays linear: block comments, long comments, backslashes and spaces', () => {
  const BIG = 100 * 1024;
  const B = String.raw`\ `.trim();
  const cases = {
    'flag and block comment repeated': '"--token", /* c '.repeat(BIG / 17) + '\n"x"',
    'open block comment lines': '"--token",\n' + '/* a\n'.repeat(BIG / 5) + '"x"',
    'block comment end lines': '"--token",\n' + ' */\n'.repeat(BIG / 4) + '"x"',
    'backslashes before quotes': (B.repeat(9) + '"--token' + B.repeat(9) + '", ').repeat(BIG / 30) + '"x"',
    'double-escaped value of backslashes': '"--token", ' + B.repeat(3) + '"' + ('a' + B).repeat(BIG / 2),
    'literal backslash-n gaps': '"--token",' + (B + 'n').repeat(BIG / 2) + '"x"',
    'wide gap': '"--token",' + ' '.repeat(BIG) + '"x"',
    'quote storm before a comment': '"'.repeat(BIG) + ' // c',
  };
  for (const [name, text] of Object.entries(cases)) {
    const t0 = process.hrtime.bigint();
    redact(text);
    const ms1 = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms1 < budget(2000), `${name}: ${ms1} ms`);
  }
});
