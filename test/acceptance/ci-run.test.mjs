import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { main, runRequired, stop } from "./ci-run.mjs";

function fixtureRoot() {
  return mkdtempSync(join(tmpdir(), "zabuni-acceptance-test-"));
}

test("runRequired terminates a command that exceeds its deadline", async () => {
  const started = Date.now();
  await assert.rejects(
    runRequired(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      process.env,
      "hung command",
      100
    ),
    /hung command timed out/u
  );
  assert.ok(Date.now() - started < 4_000, "command timeout was not bounded");
});

test("stop remains bounded when a child ignores graceful shutdown", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"
    ],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  await once(child.stdout, "data");
  const started = Date.now();
  await stop(child, 100, 500);
  assert.ok(Date.now() - started < 2_000, "forced shutdown was not bounded");
  assert.notEqual(child.exitCode ?? child.signalCode, null, "child was not terminated");
});

test("startup failure bounds logs, terminates the API, and removes temporary data", async () => {
  const fixtures = fixtureRoot();
  const temporaryRoot = fixtureRoot();
  const migration = join(fixtures, "migration.mjs");
  const api = join(fixtures, "api.mjs");
  const pidFile = join(fixtures, "api.pid");
  writeFileSync(migration, "process.exit(0);\n", "utf8");
  writeFileSync(
    api,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdout.write("x".repeat(250000));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
    "utf8"
  );
  let diagnostics = "";

  try {
    await assert.rejects(
      main({
        temporaryRoot,
        migrationEntrypoint: migration,
        apiEntrypoint: api,
        startupTimeoutMs: 1_000,
        shutdownTimeoutMs: 100,
        forceKillTimeoutMs: 500,
        stdout: () => undefined,
        stderr: (value) => {
          diagnostics += value;
        }
      }),
      /did not become ready/u
    );
    assert.ok(diagnostics.includes("Acceptance service log (bounded)"));
    assert.ok(diagnostics.length <= 201_000, "diagnostics exceeded the log bound");
    assert.equal(existsSync(temporaryRoot), false, "temporary OTP directory was not removed");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/u);
  } finally {
    rmSync(fixtures, { recursive: true, force: true });
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
