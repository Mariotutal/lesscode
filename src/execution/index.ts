import { spawn, spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface RepositoryCommand {
  repoDir: string;
  command: string;
  args?: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

/** Every repository-owned executable, including config discovery, crosses this seam. */
export interface RepositoryExecutor {
  readonly kind: "trusted-local" | "docker";
  readonly environmentId?: string;
  prepare(repoDir: string): Promise<void>;
  run(command: RepositoryCommand): Promise<CommandResult>;
  runSync(command: RepositoryCommand): CommandResult;
  dispose(): Promise<void>;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
const DEFAULT_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Credentials, NODE_OPTIONS, loader hooks, and user npm configuration are never inherited. */
export function repositoryEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    TMPDIR: tmpdir(),
    CI: "1",
    NO_COLOR: "1",
    npm_config_userconfig: "/dev/null",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch { /* process already exited */ }
}

function runHost(command: RepositoryCommand, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  const timeoutMs = command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = command.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
  if (command.signal?.aborted) return Promise.resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, error: "command aborted" });
  return new Promise((resolveResult) => {
    const child = spawn(command.command, [...command.args ?? []], {
      cwd: command.repoDir, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", outputBytes = 0, timedOut = false;
    let failure: string | undefined;
    const collect = (chunk: Buffer, target: "stdout" | "stderr") => {
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      outputBytes += chunk.length;
      const text = chunk.subarray(0, remaining).toString("utf8");
      if (target === "stdout") stdout += text; else stderr += text;
      if (outputBytes > maxOutputBytes) {
        failure = `command output exceeded ${maxOutputBytes} bytes`;
        killGroup(child.pid);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    const abort = () => { failure = "command aborted"; killGroup(child.pid); };
    command.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      failure = `command timed out after ${timeoutMs}ms`;
      killGroup(child.pid);
    }, timeoutMs);
    child.on("error", (error) => { failure = error.message; });
    child.on("close", (code) => {
      clearTimeout(timer);
      command.signal?.removeEventListener("abort", abort);
      killGroup(child.pid); // successful scripts must not leave background children behind
      resolveResult({ exitCode: failure ? null : code, stdout, stderr, timedOut, ...(failure ? { error: failure } : {}) });
    });
  });
}

function runHostSync(command: RepositoryCommand, env: NodeJS.ProcessEnv): CommandResult {
  if (command.signal?.aborted) return { exitCode: null, stdout: "", stderr: "", timedOut: false, error: "command aborted" };
  const timeoutMs = command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const spawnOptions: SpawnSyncOptionsWithStringEncoding & { detached: boolean } = {
    cwd: command.repoDir, env, detached: process.platform !== "win32", encoding: "utf8" as const,
    timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: command.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  };
  const result = spawnSync(command.command, [...command.args ?? []], spawnOptions);
  killGroup(result.pid);
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return {
    exitCode: result.error ? null : result.status,
    stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut,
    ...(result.error ? { error: timedOut ? `command timed out after ${timeoutMs}ms` : result.error.message } : {}),
  };
}

/** This adapter is for source the local developer trusts; it is not a security sandbox. */
export function createTrustedLocalExecutor(): RepositoryExecutor {
  let home: string | undefined;
  const environment = () => repositoryEnvironment(home ??= mkdtempSync(join(tmpdir(), "lc-exec-home-")));
  return {
    kind: "trusted-local",
    environmentId: `node:${process.version}`,
    async prepare() { /* dependencies are supplied by the local workspace */ },
    run: (command) => runHost(command, environment()),
    runSync: (command) => runHostSync(command, environment()),
    async dispose() { if (home) rmSync(home, { recursive: true, force: true }); home = undefined; },
  };
}

/** Legacy low-level callers use this adapter; engines should own a fresh executor per run. */
export const trustedLocalExecutor = createTrustedLocalExecutor();

export interface DockerExecutorOptions {
  /** Preinstalled image pinned by the operator. No automatic image pull is permitted. */
  image: string;
  runtime?: string;
  installNetwork?: "bridge" | "none";
  timeoutMs?: number;
}

/** Container execution never falls back to host execution. Credentials remain outside the container. */
export function createDockerExecutor(options: DockerExecutorOptions): RepositoryExecutor {
  if (!options.image.trim()) throw new Error("Docker executor requires an explicit preinstalled image");
  const runtime = options.runtime ?? "docker";
  const volumes = new Map<string, string>();
  const prepared = new Map<string, Promise<void>>();
  const active = new Set<string>();
  let disposed = false;
  let imageId: string | undefined;
  let imageResolution: Promise<string> | undefined;
  // Docker's CLI may need the operator's context; these values are never passed into containers.
  const hostEnv = repositoryEnvironment(tmpdir());
  for (const key of ["HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]) {
    if (process.env[key]) hostEnv[key] = process.env[key];
  }
  const host = (args: string[], timeoutMs = options.timeoutMs) => runHost({ repoDir: tmpdir(), command: runtime, args, timeoutMs }, hostEnv);
  const hostSync = (args: string[], timeoutMs = options.timeoutMs) => runHostSync({ repoDir: tmpdir(), command: runtime, args, timeoutMs }, hostEnv);
  const requireSuccess = (result: CommandResult, step: string): void => {
    if (result.exitCode !== 0 || result.error) throw new Error(`${step} failed: ${result.error ?? (result.stderr.trim() || `exit ${result.exitCode}`)}`);
  };
  const resolveImage = (): Promise<string> => imageResolution ??= (async () => {
    const result = await host(["image", "inspect", "--format", "{{.Id}}", options.image]);
    requireSuccess(result, "runner image inspection");
    const id = result.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error("runner image inspection returned no immutable image identity");
    imageId = id;
    return id;
  })();
  const keyFor = (repoDir: string): string => {
    if (disposed) throw new Error("Docker executor has been disposed");
    const key = resolve(repoDir);
    if (existsSync(join(key, "node_modules")) && lstatSync(join(key, "node_modules")).isSymbolicLink()) {
      throw new Error("isolated execution refuses a node_modules symlink; dependencies must be prepared inside the executor");
    }
    return key;
  };
  const argsFor = (command: RepositoryCommand, network: "none" | "bridge", name: string): string[] => {
    const key = keyFor(command.repoDir);
    const volume = volumes.get(key);
    if (!volume) throw new Error("Docker workspace is not prepared; call executor.prepare before repository execution");
    return [
      "run", "--rm", "--pull", "never", "--name", name, "--init", "--network", network,
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256",
      "--memory", "2g", "--cpus", "2", "--user", "1000:1000", "--workdir", "/workspace",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m,mode=1777", "--tmpfs", "/home/node:rw,nosuid,nodev,size=64m,mode=1777",
      "--mount", `type=bind,source=${key},target=/workspace`, "--mount", `type=volume,source=${volume},target=/workspace/node_modules`,
      ...existsSync(join(key, ".git")) ? ["--mount", `type=bind,source=${join(key, ".git")},target=/workspace/.git,readonly`] : [],
      "--env", "HOME=/home/node", "--env", "CI=1", "--env", "NO_COLOR=1", "--env", "npm_config_cache=/tmp/npm-cache",
      "--env", "npm_config_userconfig=/dev/null", "--env", "npm_config_audit=false", "--env", "npm_config_fund=false",
      "--entrypoint", command.command, imageId!, ...command.args ?? [],
    ];
  };
  return {
    kind: "docker",
    get environmentId() { return imageId; },
    async prepare(repoDir) {
      const key = keyFor(repoDir);
      let pending = prepared.get(key);
      if (!pending) {
        pending = (async () => {
          await resolveImage();
          const volume = `lesscode-deps-${randomUUID()}`;
          requireSuccess(await host(["volume", "create", volume]), "dependency volume creation");
          volumes.set(key, volume);
          // Only this fixed operator-owned command runs as root, to make the empty volume writable.
          requireSuccess(await host(["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "0:0", "--mount", `type=volume,source=${volume},target=/deps`, "--entrypoint", "node", imageId!, "-e", "require('node:fs').chmodSync('/deps', 0o777)"]), "dependency volume initialization");
          if (!existsSync(join(key, "package.json"))) return;
          const pkg = JSON.parse(readFileSync(join(key, "package.json"), "utf8")) as { packageManager?: string };
          if (pkg.packageManager && !pkg.packageManager.startsWith("npm@")) throw new Error(`unsupported package manager ${pkg.packageManager}; configure an executor that supports it`);
          const locked = existsSync(join(key, "package-lock.json"));
          const command: RepositoryCommand = { repoDir: key, command: "npm", args: [locked ? "ci" : "install", "--ignore-scripts", "--no-audit", "--no-fund", ...locked ? [] : ["--package-lock=false"]], timeoutMs: options.timeoutMs };
          const name = `lesscode-install-${randomUUID()}`;
          active.add(name);
          try { requireSuccess(await host(argsFor(command, options.installNetwork ?? "bridge", name), command.timeoutMs), "dependency preparation"); }
          finally { await host(["rm", "-f", name], 10_000); active.delete(name); }
        })();
        prepared.set(key, pending);
      }
      await pending;
    },
    async run(command) {
      const key = keyFor(command.repoDir);
      const preparation = prepared.get(key);
      if (!preparation) throw new Error("Docker workspace is not prepared; call executor.prepare before repository execution");
      await preparation;
      const name = `lesscode-command-${randomUUID()}`;
      active.add(name);
      try { return await runHost({ ...command, repoDir: tmpdir(), command: runtime, args: argsFor(command, "none", name) }, hostEnv); }
      finally { await host(["rm", "-f", name], 10_000); active.delete(name); }
    },
    runSync(command) {
      const name = `lesscode-command-${randomUUID()}`;
      const result = runHostSync({ ...command, repoDir: tmpdir(), command: runtime, args: argsFor(command, "none", name) }, hostEnv);
      hostSync(["rm", "-f", name], 10_000);
      return result;
    },
    async dispose() {
      disposed = true;
      await Promise.allSettled([...active].map((name) => host(["rm", "-f", name], 10_000)));
      await Promise.allSettled([...prepared.values()]);
      await Promise.allSettled([...volumes.values()].map((name) => host(["volume", "rm", "-f", name], 10_000)));
      active.clear(); volumes.clear(); prepared.clear();
    },
  };
}
