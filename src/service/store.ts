import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ReviewSubmission { owner: string; repo: string; prNumber: number; expectedHeadSha: string }
export interface ReviewJob {
  id: string;
  request: ReviewSubmission;
  state: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  attempts: number;
  error?: string;
}

export class StoreFullError extends Error {}

/** One process owns this directory. Multiple workers coordinate through the same in-process scheduler. */
export class ReviewJobStore {
  readonly directory: string;
  private readonly lockToken = randomUUID();
  private readonly jobs = new Map<string, ReviewJob>();
  private closed = false;

  constructor(directory: string, private readonly maxJobs = 1000, private readonly maxArtifactBytes = 4 * 1024 * 1024) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    // Serialize stale-owner recovery as well as acquisition. A crash during these few
    // filesystem operations leaves an acquisition guard for operator inspection, not two owners.
    const guard = join(this.directory, ".acquiring");
    try { mkdirSync(guard, { mode: 0o700 }); }
    catch { throw new Error("job store acquisition is already in progress; inspect a stale acquisition guard before retrying"); }
    try {
      const lock = join(this.directory, ".lock");
      if (existsSync(lock)) {
        let pid: number;
        try { pid = (JSON.parse(readFileSync(lock, "utf8")) as { pid: number }).pid; }
        catch { throw new Error("job store lock is unreadable; an operator must inspect it before recovery"); }
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("job store lock has an invalid owner");
        try { process.kill(pid, 0); throw new Error("job store is already owned by a running service process"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        rmSync(lock);
      }
      let lockFd: number;
      try { lockFd = openSync(lock, "wx", 0o600); }
      catch { throw new Error("job store is already owned by another service process"); }
      try { writeFileSync(lockFd, JSON.stringify({ pid: process.pid, token: this.lockToken })); fsyncSync(lockFd); }
      finally { closeSync(lockFd); }
    } finally { rmSync(guard, { recursive: true, force: true }); }
    try {
      const names = readdirSync(this.directory);
      for (const name of names) {
        if (/^[a-f0-9]{64}\.(?:job|artifact)\.json\.[a-f0-9-]+\.tmp$/.test(name)) rmSync(join(this.directory, name), { force: true });
      }
      const entries = names.filter((name) => /^[a-f0-9]{64}\.job\.json$/.test(name));
      if (entries.length > maxJobs) throw new Error("persisted job count exceeds configured storage limit");
      for (const name of entries) {
        const job = JSON.parse(readFileSync(join(this.directory, name), "utf8")) as ReviewJob;
        if (name !== `${this.identity(job.request)}.job.json` || job.id !== this.identity(job.request) || !["queued", "running", "completed", "failed"].includes(job.state)) throw new Error("persisted job record is invalid");
        this.jobs.set(job.id, job);
        if (job.state === "running") {
          // The artifact is written before the terminal state. Recover a completed write without rerunning it.
          if (existsSync(this.artifactPath(job.id))) this.update(job.id, { state: "completed" });
          else this.update(job.id, { state: "queued", error: "interrupted worker recovered after restart" });
        }
      }
    } catch (error) { this.close(); throw error; }
  }

  private identity(request: ReviewSubmission): string {
    return createHash("sha256").update(`${request.owner.toLowerCase()}/${request.repo.toLowerCase()}#${request.prNumber}@${request.expectedHeadSha.toLowerCase()}`).digest("hex");
  }

  private assertOpen(): void { if (this.closed) throw new Error("job store is closed"); }
  private artifactPath(id: string): string { return join(this.directory, `${id}.artifact.json`); }

  private atomicWrite(path: string, value: unknown): void {
    this.assertOpen();
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
    finally { closeSync(fd); }
    try {
      renameSync(temporary, path);
      const directoryFd = openSync(this.directory, "r");
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } finally { rmSync(temporary, { force: true }); }
  }

  find(request: ReviewSubmission): ReviewJob | undefined { this.assertOpen(); return this.get(this.identity(request)); }
  get(id: string): ReviewJob | undefined {
    this.assertOpen();
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }
  list(): ReviewJob[] { this.assertOpen(); return [...this.jobs.values()].map((job) => structuredClone(job)); }

  create(request: ReviewSubmission): { job: ReviewJob; created: boolean } {
    this.assertOpen();
    const prior = this.find(request);
    if (prior) return { job: prior, created: false };
    if (this.jobs.size >= this.maxJobs) throw new StoreFullError("job storage limit reached; archive old completed jobs before accepting more work");
    const now = new Date().toISOString();
    const job: ReviewJob = { id: this.identity(request), request: structuredClone(request), state: "queued", createdAt: now, updatedAt: now, attempts: 0 };
    this.atomicWrite(join(this.directory, `${job.id}.job.json`), job);
    this.jobs.set(job.id, job);
    return { job: structuredClone(job), created: true };
  }

  update(id: string, change: Partial<Pick<ReviewJob, "state" | "attempts" | "error">>): ReviewJob {
    const current = this.get(id);
    if (!current) throw new Error("unknown review job");
    const next = { ...current, ...change, updatedAt: new Date().toISOString() };
    this.atomicWrite(join(this.directory, `${id}.job.json`), next);
    this.jobs.set(id, next);
    return structuredClone(next);
  }

  complete(id: string, artifact: unknown): void {
    if (!this.get(id)) throw new Error("unknown review job");
    const text = JSON.stringify(artifact);
    if (Buffer.byteLength(text) > this.maxArtifactBytes) throw new Error("review artifact exceeds configured storage limit");
    this.atomicWrite(this.artifactPath(id), artifact);
    this.update(id, { state: "completed", error: undefined });
  }

  artifact(id: string): unknown {
    const job = this.get(id);
    if (!job || job.state !== "completed") throw new Error("review artifact is not available");
    return JSON.parse(readFileSync(this.artifactPath(id), "utf8"));
  }

  close(): void {
    if (this.closed) return;
    const lock = join(this.directory, ".lock");
    if (existsSync(lock)) {
      const owner = JSON.parse(readFileSync(lock, "utf8")) as { token: string };
      if (owner.token === this.lockToken) rmSync(lock);
    }
    this.closed = true;
  }
}
