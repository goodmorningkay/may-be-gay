import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runBoundedCommand } from "../../src/server/subprocess/bounded";
import { native } from "../../src/server/recovery/native";

const q = JSON.stringify;

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state !== "Z";
  } catch {
    return false;
  }
}

async function waitGone(pid: number, deadline = Date.now() + 2000) {
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await pause(10);
  }
}

async function waitStarted(file: string, deadline = Date.now() + 5000): Promise<number> {
  while (Date.now() < deadline) {
    const raw = await readFile(file, "utf8").catch(() => "");
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 1) return pid;
    await pause(10);
  }
  throw new Error(`Timed out waiting for pid file ${file}`);
}

describe("bounded subprocesses and native recovery commands", () => {
  let root: string | undefined;

  afterEach(async () => {
    delete process.env.NATIVE_TEST_SECRET;
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  async function spawnTreeFixture() {
    root = await mkdtemp(path.join(os.tmpdir(), "bounded-tree-"));
    const childPidFile = path.join(root, "child.pid");
    const parentPidFile = path.join(root, "parent.pid");
    const markerFile = path.join(root, "late");
    const releaseFile = path.join(root, "release");
    const grandchild = path.join(root, "grandchild.cjs");
    const tool = path.join(root, "tool.cjs");

    await writeFile(
      grandchild,
      `const fs=require('node:fs');fs.writeFileSync(${q(childPidFile)},String(process.pid));
      const t=setInterval(()=>{if(fs.existsSync(${q(releaseFile)})){clearInterval(t);setTimeout(()=>fs.writeFileSync(${q(markerFile)},'late'),250);}},10);`,
    );
    await writeFile(
      tool,
      `const fs=require('node:fs');fs.writeFileSync(${q(parentPidFile)},String(process.pid));
      require('node:child_process').spawn(process.execPath,['--jitless',${q(grandchild)}],{stdio:'ignore'}).unref();
      setInterval(()=>{},1000);`,
    );

    return { childPidFile, parentPidFile, markerFile, releaseFile, tool };
  }

  it("kills the entire process group on timeout", async () => {
    const f = await spawnTreeFixture();
    const running = runBoundedCommand(process.execPath, ["--jitless", f.tool], {
      timeoutMs: 400,
      env: { PATH: process.env.PATH },
    });
    const childPid = await waitStarted(f.childPidFile);
    const parentPid = await waitStarted(f.parentPidFile);
    const res = await running;
    expect(res.timedOut).toBe(true);
    await waitGone(childPid);
    expect(alive(childPid)).toBe(false);
    expect(alive(parentPid)).toBe(false);
    await writeFile(f.releaseFile, "go");
    await pause(350);
    expect(existsSync(f.markerFile)).toBe(false);
  }, 10000);

  it("kills the entire process group on abort and short-circuits pre-aborted signals", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const immediate = await runBoundedCommand("/nonexistent", [], {
      timeoutMs: 1000,
      env: {},
      signal: preAborted.signal,
    });
    expect(immediate).toEqual({
      code: null,
      timedOut: false,
      aborted: true,
      unavailable: false,
      stdout: "",
      outputExceeded: false,
    });

    const f = await spawnTreeFixture();
    const abort = new AbortController();
    const running = runBoundedCommand(process.execPath, ["--jitless", f.tool], {
      timeoutMs: 5000,
      env: { PATH: process.env.PATH },
      signal: abort.signal,
    });
    const childPid = await waitStarted(f.childPidFile);
    const parentPid = await waitStarted(f.parentPidFile);
    abort.abort();
    const res = await running;
    expect(res.aborted).toBe(true);
    await waitGone(childPid);
    expect(alive(childPid)).toBe(false);
    expect(alive(parentPid)).toBe(false);
  }, 10000);

  it("cleans up lingering process-group members on normal exit", async () => {
    const f = await spawnTreeFixture();
    await writeFile(
      f.tool,
      `const {spawn}=require('node:child_process');const fs=require('node:fs');
      spawn(process.execPath,['--jitless',${q(path.join(root!, "grandchild.cjs"))}],{stdio:'ignore'}).unref();
      const t=setInterval(()=>{if(fs.existsSync(${q(f.childPidFile)})){clearInterval(t);process.exit(0);}},10);`,
    );
    const res = await runBoundedCommand(process.execPath, ["--jitless", f.tool], {
      timeoutMs: 5000,
      env: { PATH: process.env.PATH },
    });
    expect(res.code).toBe(0);
    const childPid = await waitStarted(f.childPidFile);
    await waitGone(childPid);
    expect(alive(childPid)).toBe(false);
  }, 10000);

  it("enforces maxOutputBytes and reports unavailable tools cleanly", async () => {
    const overflow = await runBoundedCommand(
      process.execPath,
      ["--jitless", "-e", "process.stdout.write('x'.repeat(2000));setInterval(()=>{},1000)"],
      { timeoutMs: 5000, env: { PATH: process.env.PATH }, captureStdout: true, maxOutputBytes: 1024 },
    );
    expect(overflow.outputExceeded).toBe(true);
    expect(overflow.stdout.length).toBeLessThanOrEqual(1024);

    const missing = await runBoundedCommand("/nonexistent/private-secret", [], {
      timeoutMs: 1000,
      env: {},
    });
    expect(missing.unavailable).toBe(true);
  });

  it("recovery abort kills descendants without leaking credentials and enforces output/env bounds", async () => {
    const f = await spawnTreeFixture();
    const abort = new AbortController();
    const running = native(process.execPath, [f.tool], "postgres://private:secret@127.0.0.1/test", abort.signal, true).catch(e => e);
    const childPid = await waitStarted(f.childPidFile);
    const parentPid = await waitStarted(f.parentPidFile);
    abort.abort();
    expect(await running).toEqual(new Error("POSTGRES_TOOL_FAILED"));
    await waitGone(childPid);
    expect(alive(childPid)).toBe(false);
    expect(alive(parentPid)).toBe(false);

    process.env.NATIVE_TEST_SECRET = "must-not-reach-native";
    expect(
      await native(process.execPath, ["-e", "process.stdout.write(String(process.env.NATIVE_TEST_SECRET))"], "postgres://private:secret@127.0.0.1/test", new AbortController().signal, true),
    ).toBe("undefined");
    await expect(
      native(process.execPath, ["-e", "process.stdout.write('x'.repeat(70000));setInterval(()=>{},1000)"], "postgres://private:secret@127.0.0.1/test", new AbortController().signal, true),
    ).rejects.toEqual(new Error("POSTGRES_TOOL_FAILED"));
    await expect(
      native("/nonexistent/pg_dump", ["--version"], "postgres://private:secret@127.0.0.1/test", new AbortController().signal, true),
    ).rejects.toEqual(new Error("POSTGRES_TOOL_UNAVAILABLE"));
  }, 10000);
});
