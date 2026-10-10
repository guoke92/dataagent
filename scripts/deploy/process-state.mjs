import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const SENSITIVE_KEY = /KEY|SECRET|TOKEN|PASSWORD|COOKIE|AUTHORIZATION/i;

export function deploymentPaths(root) {
  return {
    logsDir: path.join(root, "storage/logs"),
    runDir: path.join(root, "storage/run"),
    runtimeLog: path.join(root, "storage/logs/datafoundry.log"),
    pidFile: path.join(root, "storage/run/datafoundry.pid"),
    deploymentJson: path.join(root, "storage/run/deployment.json")
  };
}

export function validateDeploymentState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("deployment state must be an object");
  }
  for (const key of Object.keys(state)) {
    if (SENSITIVE_KEY.test(key)) {
      throw new Error(`sensitive field ${key}`);
    }
  }
  return state;
}

async function writeAtomicJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
}

export async function writeDeploymentState(root, state) {
  validateDeploymentState(state);
  const paths = deploymentPaths(root);
  await mkdir(paths.runDir, { recursive: true });
  await writeAtomicJson(paths.deploymentJson, state);
  await writeFile(paths.pidFile, `${state.pid}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readDeploymentState(root) {
  const filePath = deploymentPaths(root).deploymentJson;
  try {
    const raw = await readFile(filePath, "utf8");
    return validateDeploymentState(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function rotateRuntimeLog(logPath, options = {}) {
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  const retain = options.retain ?? 5;
  await mkdir(path.dirname(logPath), { recursive: true });
  try {
    const info = await stat(logPath);
    if (info.size <= maxBytes) return;
  } catch (error) {
    if (error?.code === "ENOENT") {
      await writeFile(logPath, "", { encoding: "utf8", mode: 0o600 });
      return;
    }
    throw error;
  }

  await rm(`${logPath}.${retain}`, { force: true });
  for (let i = retain - 1; i >= 1; i -= 1) {
    const from = `${logPath}.${i}`;
    const to = `${logPath}.${i + 1}`;
    if (existsSync(from)) await rename(from, to);
  }
  await rename(logPath, `${logPath}.1`);
  await writeFile(logPath, "", { encoding: "utf8", mode: 0o600 });
}

function launchIdVerificationEnabled(options = {}) {
  return Boolean(options.forceLaunchIdCheck) || process.platform === "linux" || process.platform === "darwin";
}

async function readLaunchIdFromProcAsync(pid) {
  try {
    const environ = await readFile(`/proc/${pid}/environ`);
    const match = /DATAFOUNDRY_LAUNCH_ID=([^\0]+)/.exec(environ.toString("utf8"));
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function readDarwinProcessMarker(pid) {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-Eww", "-p", String(pid)],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve({ launchId: null, envVisible: false });
          return;
        }
        const text = String(stdout ?? "");
        const match = /(?:^|\s)DATAFOUNDRY_LAUNCH_ID=([^\s]+)/.exec(text);
        // Platform binaries such as /bin/bash hide their environment from ps.
        // A visible PATH/HOME means the marker was readable and is simply absent.
        const envVisible = /(?:^|\s)(?:PATH|HOME|USER|SHELL)=/.test(text);
        resolve({ launchId: match?.[1] ?? null, envVisible });
      }
    );
  });
}

function defaultReadLaunchId(pid) {
  if (process.platform === "darwin") {
    return readDarwinProcessMarker(pid).then((marker) => marker.launchId);
  }
  return readLaunchIdFromProcAsync(pid);
}

export async function verifyManagedProcessForStop(pid, expectedLaunchId, options = {}) {
  if (!launchIdVerificationEnabled(options)) {
    return { allowed: true };
  }

  if (!expectedLaunchId) {
    return { allowed: false, reason: "missing-expected-launch-id" };
  }

  if (process.platform === "darwin" && options.readLaunchId == null) {
    const marker = await readDarwinProcessMarker(pid);
    if (marker.launchId === expectedLaunchId) return { allowed: true };
    if (marker.launchId) return { allowed: false, reason: "launch-id-mismatch" };
    if (!marker.envVisible) return { allowed: true };
    return { allowed: false, reason: "launch-id-unverified" };
  }

  const readLaunchId = options.readLaunchId ?? defaultReadLaunchId;
  const launchId = await readLaunchId(pid);

  if (launchId === expectedLaunchId) {
    return { allowed: true };
  }
  if (launchId && launchId !== expectedLaunchId) {
    return { allowed: false, reason: "launch-id-mismatch" };
  }

  // Never fall back to cmdline heuristics — an unverifiable launch marker must refuse stop.
  return { allowed: false, reason: "launch-id-unverified" };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clearDeploymentState(root) {
  const paths = deploymentPaths(root);
  await rm(paths.deploymentJson, { force: true });
  await rm(paths.pidFile, { force: true });
}

/**
 * Returns whether the recorded deployment process is a verified managed stack.
 * Alive pid + failed launchId verification is treated as stale (not running).
 */
export async function inspectManagedRuntime(root, options = {}) {
  const state = await readDeploymentState(root);
  if (!state?.pid) {
    return { state: null, running: false, stale: false, reason: "not-running" };
  }
  if (!isProcessAlive(state.pid)) {
    return { state, running: false, stale: true, reason: "dead-pid" };
  }

  if (launchIdVerificationEnabled(options)) {
    const verification = await verifyManagedProcessForStop(state.pid, state.launchId, options);
    if (!verification.allowed) {
      return {
        state,
        running: false,
        stale: true,
        reason: verification.reason ?? "stale-launch-id"
      };
    }
  }

  return { state, running: true, stale: false, reason: "running" };
}

export async function healStaleDeploymentState(root, options = {}) {
  const inspection = await inspectManagedRuntime(root, options);
  if (!inspection.stale) return inspection;
  await clearDeploymentState(root);
  return { ...inspection, state: null, healed: true };
}

export async function startManagedStack(root, options = {}) {
  const existing = await readDeploymentState(root);
  if (existing?.pid && isProcessAlive(existing.pid)) {
    const healed = await healStaleDeploymentState(root, options);
    if (!healed.stale) {
      throw new Error(`DataFoundry is already running with pid ${existing.pid}`);
    }
  } else if (existing?.pid && !isProcessAlive(existing.pid)) {
    await clearDeploymentState(root);
  }

  const paths = deploymentPaths(root);
  await mkdir(paths.logsDir, { recursive: true });
  await mkdir(paths.runDir, { recursive: true });
  await rotateRuntimeLog(paths.runtimeLog);

  const launchId = options.launchId ?? randomBytes(16).toString("hex");
  const command = options.command ?? "npm";
  const args = options.args ?? ["run", "start"];
  const env = {
    ...(options.env ?? process.env),
    DATAFOUNDRY_LAUNCH_ID: launchId
  };

  const logFd = await open(paths.runtimeLog, "a", 0o600);
  let child;
  try {
    child = spawn(command, args, {
      cwd: root,
      env,
      detached: true,
      stdio: ["ignore", logFd.fd, logFd.fd],
      // npm is npm.cmd on Windows and cannot be spawned without a shell.
      shell: process.platform === "win32",
      windowsHide: true
    });
  } finally {
    await logFd.close();
  }

  child.unref();

  const state = {
    pid: child.pid,
    pgid: child.pid,
    launchId,
    status: "starting",
    startedAt: new Date().toISOString(),
    commitSha: options.commitSha ?? null,
    ports: options.ports ?? null
  };
  await writeDeploymentState(root, state);
  return state;
}

function signalManagedPid(pid, signal) {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
    } catch {
      process.kill(pid, signal);
    }
    return Promise.resolve();
  }

  const args = ["/PID", String(pid), "/T"];
  if (signal === "SIGKILL") args.push("/F");
  return new Promise((resolve, reject) => {
    execFile("taskkill", args, { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function stopManagedStack(root, options = {}) {
  const state = await readDeploymentState(root);
  if (!state?.pid) return { stopped: false, reason: "not-running" };
  if (!isProcessAlive(state.pid)) {
    await clearDeploymentState(root);
    return { stopped: false, reason: "stale" };
  }

  if (launchIdVerificationEnabled(options)) {
    const verification = await verifyManagedProcessForStop(state.pid, state.launchId, options);
    if (!verification.allowed) {
      // PID reuse / foreign process: never signal, but clear stale state so start can recover.
      await clearDeploymentState(root);
      return {
        stopped: false,
        reason: "stale-launch-id",
        detail: verification.reason
      };
    }
  }

  try {
    await signalManagedPid(state.pid, "SIGTERM");
  } catch {
    // Windows taskkill without /F often fails for console trees; SIGKILL follows.
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(state.pid)) {
      await clearDeploymentState(root);
      return { stopped: true, reason: "terminated" };
    }
    await sleep(100);
  }

  try {
    await signalManagedPid(state.pid, "SIGKILL");
  } catch {
    // process may have exited between checks
  }

  const killTimeoutMs = options.killTimeoutMs ?? 5_000;
  const killDeadline = Date.now() + killTimeoutMs;
  while (Date.now() < killDeadline) {
    if (!isProcessAlive(state.pid)) {
      await clearDeploymentState(root);
      return { stopped: true, reason: "killed" };
    }
    await sleep(100);
  }

  if (!isProcessAlive(state.pid)) {
    await clearDeploymentState(root);
    return { stopped: true, reason: "killed" };
  }

  throw new Error(`Timed out waiting for pid ${state.pid} to exit after SIGKILL`);
}