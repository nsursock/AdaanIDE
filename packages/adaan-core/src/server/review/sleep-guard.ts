import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";

/**
 * Prevents OS idle sleep while review runs are in flight (the "Mac goes to
 * sleep mid-run" failure). On macOS we hold a reference-counted sidecar
 * `caffeinate -i` process; on other platforms this is a no-op.
 *
 * `-i` asserts the "idle sleep" prevention — exactly what a network-bound
 * committee review needs. We don't assert display sleep (`-d`), and `-s`
 * (AC-only) isn't required. The refcount lets concurrent scheduled + manual
 * runs share one sidecar; the process is killed when the last run releases.
 */
class SleepGuard {
  private count = 0;
  private proc: ChildProcess | null = null;
  /** Test hook: pretend to run on a non-macOS platform (or force on). */
  platform: NodeJS.Platform = os.platform();

  /** True while at least one run holds the guard. */
  get active(): boolean {
    return this.count > 0;
  }

  /** True when a caffeinate sidecar is actually alive. */
  get spawned(): boolean {
    return this.proc !== null;
  }

  acquire(): void {
    this.count++;
    if (this.proc || this.platform !== "darwin") return;
    try {
      const p = spawn("caffeinate", ["-i"], { stdio: "ignore" });
      p.on("error", () => { this.proc = null; });
      p.on("exit", () => { this.proc = null; });
      // Never keep the parent alive on account of the sidecar.
      p.unref();
      this.proc = p;
    } catch {
      this.proc = null;
    }
  }

  release(): void {
    this.count = Math.max(0, this.count - 1);
    if (this.count === 0 && this.proc) {
      try { this.proc.kill("SIGTERM"); } catch { /* already dead */ }
      this.proc = null;
    }
  }

  /** Test hook: reset all state (kills the sidecar if any). */
  _reset(): void {
    this.count = 0;
    if (this.proc) {
      try { this.proc.kill("SIGTERM"); } catch { /* already dead */ }
      this.proc = null;
    }
  }
}

/** Shared singleton — one caffeinate for the whole process. */
export const sleepGuard = new SleepGuard();
