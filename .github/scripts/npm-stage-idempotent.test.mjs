// Tests for npm-stage-idempotent.sh with a stubbed npm: run with `node --test .github/scripts/npm-stage-idempotent.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "npm-stage-idempotent.sh");
const bytes = Buffer.from("tarball bytes");
const good = "sha512-" + createHash("sha512").update(bytes).digest("base64");
const other = "sha512-" + createHash("sha512").update("some other file").digest("base64");

// Stub npm. STUB_LIVE is what `npm view ... dist.integrity` prints ("" = not public). STUB_LIVE_AFTER replaces it
// once `stage publish` has run. STUB_STAGE is a list of exit codes (one per call), STUB_STAGE_MSG the stderr text.
function run({ live = "", liveAfter, stage = [0], msg = "", att = "" }) {
  const dir = mkdtempSync(join(tmpdir(), "npmstage-"));
  writeFileSync(join(dir, "zn-gate-1.2.3.tgz"), bytes);
  writeFileSync(join(dir, "stage-codes"), stage.join("\n") + "\n");
  writeFileSync(join(dir, "calls"), "");
  const stub = join(dir, "npm");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls"
if [ "$1" = view ]; then
  case "$3" in
    dist.integrity) if [ -f "${dir}/staged" ] && [ -n "${liveAfter ?? ""}" ]; then echo "${liveAfter ?? ""}"; else echo "${live}"; fi ;;
    dist.attestations.url) echo "${att}" ;;
  esac
  exit 0
fi
if [ "$1" = stage ]; then
  touch "${dir}/staged"
  code="$(head -n 1 "${dir}/stage-codes")"
  tail -n +2 "${dir}/stage-codes" > "${dir}/stage-codes.next"; mv "${dir}/stage-codes.next" "${dir}/stage-codes"
  [ -n "$code" ] || code=0
  [ -z "${msg}" ] || echo "${msg}" >&2
  exit "$code"
fi
exit 99
`,
  );
  chmodSync(stub, 0o755);
  const ghOut = join(dir, "gh-output");
  writeFileSync(ghOut, "");
  const r = spawnSync("bash", [script], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      NPM_BIN: stub,
      NPM_VERSION: "1.2.3",
      DIST_TAG: "latest",
      TARBALL: "zn-gate-1.2.3.tgz",
      STAGE_RETRY_SECONDS: "0",
      STAGE_OUTPUT: join(dir, "stage-output.txt"),
      GITHUB_OUTPUT: ghOut,
    },
  });
  const calls = readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean);
  return {
    status: r.status,
    text: r.stdout + r.stderr,
    stageCalls: calls.filter((c) => c.startsWith("stage")).length,
    result: (readFileSync(ghOut, "utf8").match(/result=(\S+)/) || [])[1],
    output: existsSync(join(dir, "stage-output.txt")) ? readFileSync(join(dir, "stage-output.txt"), "utf8") : "",
  };
}

const msg409 = "npm error code E409\nnpm error 409 Conflict: an equivalent entry already exists in the transparency log";

test("a version already public with the same integrity is skipped without staging", () => {
  const r = run({ live: good, att: "https://registry.npmjs.org/-/npm/v1/attestations/zn-gate@1.2.3" });
  assert.equal(r.status, 0);
  assert.equal(r.stageCalls, 0);
  assert.equal(r.result, "already-live");
});

test("a version public with another integrity fails loudly and does not stage", () => {
  const r = run({ live: other });
  assert.equal(r.status, 1);
  assert.equal(r.stageCalls, 0);
  assert.match(r.text, /already on npm with integrity/);
});

test("a normal stage succeeds once", () => {
  const r = run({});
  assert.equal(r.status, 0);
  assert.equal(r.stageCalls, 1);
  assert.equal(r.result, "staged");
});

test("a 409 with the same integrity public afterwards is treated as done", () => {
  const r = run({ liveAfter: good, stage: [1], msg: msg409 });
  assert.equal(r.status, 0);
  assert.equal(r.stageCalls, 1);
  assert.equal(r.result, "already-live");
  assert.match(r.output, /equivalent entry/);
});

test("a 409 with another integrity public afterwards fails loudly", () => {
  const r = run({ liveAfter: other, stage: [1], msg: msg409 });
  assert.equal(r.status, 1);
  assert.match(r.text, /already on npm with integrity/);
});

test("a 409 while the version is not public is retried and can then stage", () => {
  const r = run({ stage: [1, 0], msg: msg409 });
  assert.equal(r.status, 0);
  assert.equal(r.stageCalls, 2);
  assert.equal(r.result, "staged");
});

test("a 409 that never clears fails after the attempts", () => {
  const r = run({ stage: [1, 1, 1, 1], msg: msg409 });
  assert.equal(r.status, 1);
  assert.equal(r.stageCalls, 3);
  assert.match(r.text, /kept answering 409/);
});

test("any other stage failure fails at once without a retry", () => {
  const r = run({ stage: [1, 0], msg: "npm error code E403\nnpm error 403 Forbidden" });
  assert.equal(r.status, 1);
  assert.equal(r.stageCalls, 1);
  assert.match(r.text, /not a 409/);
});
