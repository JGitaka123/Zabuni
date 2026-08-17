#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STARTUP_TIMEOUT_MS = 30_000;
const MIGRATION_TIMEOUT_MS = 60_000;
const ACCEPTANCE_TIMEOUT_MS = 5 * 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const FORCE_KILL_TIMEOUT_MS = 2_000;
const MAX_CAPTURED_LOG_CHARS = 200_000;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function deadline(milliseconds, value) {
  let timer;
  const promise = new Promise((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline(value), milliseconds);
    timer.unref();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function capture(stream, state) {
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    state.value = `${state.value}${chunk}`.slice(-MAX_CAPTURED_LOG_CHARS);
  });
}

export async function stop(
  child,
  shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
  forceKillTimeoutMs = FORCE_KILL_TIMEOUT_MS
) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit").then(() => true);
  child.kill("SIGTERM");
  const gracefulDeadline = deadline(shutdownTimeoutMs, false);
  const exitedGracefully = await Promise.race([exited, gracefulDeadline.promise]);
  gracefulDeadline.cancel();
  if (exitedGracefully) return;
  child.kill("SIGKILL");
  const forceDeadline = deadline(forceKillTimeoutMs, false);
  await Promise.race([exited, forceDeadline.promise]);
  forceDeadline.cancel();
}

export async function runRequired(command, args, environment, label, timeoutMs) {
  const child = spawn(command, args, { env: environment, stdio: "inherit" });
  const commandDeadline = deadline(timeoutMs, { kind: "timeout" });
  let outcome;
  try {
    outcome = await Promise.race([
      once(child, "exit").then(([code, signal]) => ({ kind: "exit", code, signal })),
      once(child, "error").then(([error]) => {
        throw error;
      }),
      commandDeadline.promise
    ]);
  } finally {
    commandDeadline.cancel();
  }
  if (outcome.kind === "timeout") {
    await stop(child, 1_000, 1_000);
    throw new Error(`${label} timed out after ${String(timeoutMs)}ms`);
  }
  const { code, signal } = outcome;
  if (code !== 0) {
    throw new Error(`${label} exited with code ${String(code)} signal ${String(signal)}`);
  }
}

async function waitUntilReady(child, apiOrigin, spawnFailure, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnFailure.value !== undefined) throw spawnFailure.value;
    if (child.exitCode !== null) {
      throw new Error(`API exited before readiness with code ${String(child.exitCode)}`);
    }
    try {
      const response = await fetch(`${apiOrigin}/ready`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200) return;
    } catch {
      // Startup races are expected until the listener and pools are ready.
    }
    await delay(250);
  }
  throw new Error(`API did not become ready within ${String(timeoutMs)}ms`);
}

export async function main(options = {}) {
  const temporaryRoot = options.temporaryRoot ?? mkdtempSync(join(tmpdir(), "zabuni-acceptance-"));
  const port = process.env.ACCEPTANCE_PORT ?? "3101";
  const apiOrigin = `http://127.0.0.1:${port}`;
  const webOrigin = "http://localhost:3000";
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    INTEGRATION_MODE: "fixture",
    PORT: port,
    BETTER_AUTH_URL: apiOrigin,
    WEB_ORIGIN: webOrigin,
    TRUSTED_PROXY_IP_HEADER: "x-forwarded-for",
    FIXTURE_OTP_MAILBOX: join(temporaryRoot, "otp.jsonl"),
    ZABUNI_API: apiOrigin,
    ZABUNI_WEB_ORIGIN: webOrigin,
    ACCEPTANCE_REPORT: join(temporaryRoot, "acceptance-report.md")
  };
  const output = { value: "" };
  const spawnFailure = { value: undefined };
  let api;
  const writeOutput = options.stdout ?? ((value) => process.stdout.write(value));
  const writeError = options.stderr ?? ((value) => process.stderr.write(value));
  const migrationEntrypoint = options.migrationEntrypoint ?? resolve("packages/db/dist/migrate-cli.js");
  const apiEntrypoint = options.apiEntrypoint ?? resolve("apps/api/dist/index.js");
  const acceptanceEntrypoint =
    options.acceptanceEntrypoint ?? resolve("test/acceptance/run.mjs");
  const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const migrationTimeoutMs = options.migrationTimeoutMs ?? MIGRATION_TIMEOUT_MS;
  const acceptanceTimeoutMs = options.acceptanceTimeoutMs ?? ACCEPTANCE_TIMEOUT_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const forceKillTimeoutMs = options.forceKillTimeoutMs ?? FORCE_KILL_TIMEOUT_MS;

  try {
    await runRequired(
      process.execPath,
      [migrationEntrypoint],
      environment,
      "database migration",
      migrationTimeoutMs
    );
    api = spawn(process.execPath, [apiEntrypoint], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    api.once("error", (error) => {
      spawnFailure.value = error;
    });
    capture(api.stdout, output);
    capture(api.stderr, output);
    await waitUntilReady(api, apiOrigin, spawnFailure, startupTimeoutMs);
    writeOutput(`Acceptance API ready at ${apiOrigin}\n`);
    await runRequired(
      process.execPath,
      [acceptanceEntrypoint],
      environment,
      "acceptance suite",
      acceptanceTimeoutMs
    );
  } catch (error) {
    writeError(`\nAcceptance service log (bounded):\n${output.value}\n`);
    throw error;
  } finally {
    if (api !== undefined) await stop(api, shutdownTimeoutMs, forceKillTimeoutMs);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) await main();
