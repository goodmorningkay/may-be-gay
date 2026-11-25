import { spawn } from "node:child_process";

export type BoundedResult = {
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  unavailable: boolean;
  stdout: string;
  outputExceeded: boolean;
};

/**
 * Run a command in its own process group with wall-clock, abort, and output bounds.
 * Kills the entire process group on timeout, abort, output overflow, and normal exit.
 */
export function runBoundedCommand(
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    env: Record<string, string | undefined>;
    signal?: AbortSignal;
    captureStdout?: boolean;
    captureStderr?: boolean;
    maxOutputBytes?: number;
  },
): Promise<BoundedResult> {
  const { timeoutMs, env, signal, captureStdout = false, captureStderr = false, maxOutputBytes } = options;

  if (signal?.aborted) {
    return Promise.resolve({
      code: null,
      timedOut: false,
      aborted: true,
      unavailable: false,
      stdout: "",
      outputExceeded: false,
    });
  }

  return new Promise(resolve => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let unavailable = false;
    let outputExceeded = false;
    let totalBytes = 0;
    const stdoutChunks: Buffer[] = [];

    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", captureStdout ? "pipe" : "ignore", captureStderr ? "pipe" : "ignore"],
      env: env as NodeJS.ProcessEnv,
    });

    const killGroup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore ESRCH when process has already exited.
      }
    };

    const onAbort = () => {
      aborted = true;
      killGroup();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      killGroup();
      resolve({
        code,
        timedOut,
        aborted,
        unavailable,
        stdout: Buffer.concat(stdoutChunks).toString(),
        outputExceeded,
      });
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    const onData = (isStdout: boolean) => (chunk: Buffer) => {
      if (outputExceeded) return;
      totalBytes += chunk.length;
      if (maxOutputBytes !== undefined && totalBytes > maxOutputBytes) {
        outputExceeded = true;
        killGroup();
        return;
      }
      if (isStdout) stdoutChunks.push(chunk);
    };

    child.stdout?.on("data", onData(true));
    child.stderr?.on("data", onData(false));

    child.on("error", () => {
      unavailable = true;
      finish(null);
    });

    child.on("close", code => {
      finish(code);
    });
  });
}
