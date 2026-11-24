import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runProcessor } from "../../src/server/worker/process";
import { runBoundedProcess } from "../../src/server/media/validation";
import { native } from "../../src/server/recovery/native";
import { cancelSupervised, spawnSupervised } from "../../src/server/subprocess/supervised";
import type { Claim } from "../../src/server/worker/queue";
import { alive, compileGuardian, noLateMarker, pause, started, waitGone } from "./native-supervision-fixture";

const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
const q = JSON.stringify;
describe("native descendant lifetime boundaries", () => {
  let guardian: Awaited<ReturnType<typeof compileGuardian>>;
  beforeAll(async () => {
    guardian = await compileGuardian();
    vi.stubEnv("NATIVE_GUARDIAN_BIN", guardian.binary);
    vi.stubEnv("NATIVE_PARSER_LOCK_FILE", path.join(path.dirname(guardian.binary), "parser.lock"));
  });
  afterAll(async () => { vi.unstubAllEnvs(); await guardian?.dispose(); });

  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "native-tree-"));
    const pid = path.join(root, "started"), parentPid = path.join(root, "parent"), marker = path.join(root, "late"), release = path.join(root, "release");
    const grandchild = path.join(root, "grandchild.cjs"), tool = path.join(root, "tool.cjs"), entry = path.join(root, "processor.mts");
    // Detaching deliberately exercises adoption of a process outside the tool's
    // group. Its startup signal comes from the descendant, not its spawner.
    await writeFile(grandchild, `const fs=require('node:fs');fs.writeFileSync(${q(pid)},String(process.pid));
      const timer=setInterval(()=>{if(fs.existsSync(${q(release)})){clearInterval(timer);setTimeout(()=>fs.writeFileSync(${q(marker)},'late'),350);}},10);`);
    await writeFile(tool, `const fs=require('node:fs');fs.writeFileSync(${q(parentPid)},String(process.pid));
      require('node:child_process').spawn(process.execPath,['--jitless',${q(grandchild)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);`);
    const pids: number[] = [];
    return { root, pid, parentPid, marker, release, tool, entry, pids, async dispose() {
      // Emergency cleanup is only for failed tests. Never target unrelated PIDs.
      for (const file of [pid, parentPid]) { const value = Number(await readFile(file, "utf8").catch(() => "")); if (value > 1) pids.push(value); }
      for (const child of pids) {
        const command = await readFile(`/proc/${child}/cmdline`).catch(() => Buffer.alloc(0));
        if (command.includes(Buffer.from(root))) { try { process.kill(child, "SIGKILL"); } catch {} }
      }
      await rm(root, { recursive: true, force: true });
    } };
  }

  async function processorEntry(f: Awaited<ReturnType<typeof fixture>>, mode: "parser" | "recovery", timeout = 5000) {
    await writeFile(f.entry, `import {writeFileSync} from 'node:fs';
      import {${mode === "parser" ? "runBoundedProcess" : "native"}} from ${moduleUrl(mode === "parser" ? "src/server/media/validation.ts" : "src/server/recovery/native.ts")};
      writeFileSync(${q(path.join(f.root, "processor"))},String(process.pid));process.stdin.resume();
      try { await ${mode === "parser" ? `runBoundedProcess(process.execPath,['--jitless',${q(f.tool)}],${timeout})` : `native(process.execPath,['--jitless',${q(f.tool)}],'postgres://test:private@127.0.0.1/test',new AbortController().signal)`}; process.send?.({code:'OK'}); }
      catch(e) { process.send?.({code:e?.code || 'TEST_FAILED'}); } finally { process.disconnect?.(); }`);
  }

  it.each(["parser", "recovery"] as const)("outer processor abort joins %s native grandchildren before returning", async mode => {
    const f = await fixture(), abort = new AbortController();
    let running: Promise<string | undefined> | undefined;
    try {
      await processorEntry(f, mode);
      running = runProcessor({} as Claim, abort.signal, 8000, f.entry);
      const child = await started(f.pid), tool = await started(f.parentPid);
      abort.abort();
      expect(await running).toBe("LEASE_LOST_OR_SHUTDOWN");
      expect(alive(child)).toBe(false); expect(alive(tool)).toBe(false);
      await writeFile(f.release, "go"); await noLateMarker(f.marker);
    } finally { abort.abort(); await running; await f.dispose(); }
  }, 10000);

  it("outer processor deadline joins already-started parser descendants", async () => {
    const f = await fixture(), abort = new AbortController();
    let running: Promise<string | undefined> | undefined;
    try {
      await processorEntry(f, "parser");
      running = runProcessor({} as Claim, abort.signal, 1500, f.entry);
      const child = await started(f.pid), tool = await started(f.parentPid);
      expect(await running).toBe("PROCESSOR_TIMEOUT");
      expect(alive(child)).toBe(false); expect(alive(tool)).toBe(false);
      await writeFile(f.release, "go"); await noLateMarker(f.marker);
    } finally { abort.abort(); await running; await f.dispose(); }
  }, 10000);

  it.each(["parser", "recovery"] as const)("abrupt intermediate processor SIGKILL still joins the %s tree", async mode => {
    const f = await fixture(), abort = new AbortController();
    let running: Promise<string | undefined> | undefined;
    try {
      await processorEntry(f, mode);
      running = runProcessor({} as Claim, abort.signal, 8000, f.entry);
      const child = await started(f.pid), tool = await started(f.parentPid), processor = await started(path.join(f.root, "processor"));
      process.kill(processor, "SIGKILL");
      expect(await running).toBe("PROCESSOR_CRASH");
      expect(alive(child)).toBe(false); expect(alive(tool)).toBe(false);
      await writeFile(f.release, "go"); await noLateMarker(f.marker);
    } finally { abort.abort(); await running; await f.dispose(); }
  }, 10000);

  it("parser wall timeout through a processor joins descendants before reporting the limit", async () => {
    const f = await fixture(), abort = new AbortController();
    let running: Promise<string | undefined> | undefined;
    try {
      await processorEntry(f, "parser", 700);
      running = runProcessor({} as Claim, abort.signal, 8000, f.entry);
      const child = await started(f.pid), tool = await started(f.parentPid);
      expect(await running).toBe("MEDIA_PROCESSING_LIMIT");
      expect(alive(child)).toBe(false); expect(alive(tool)).toBe(false);
      await writeFile(f.release, "go"); await noLateMarker(f.marker);
    } finally { abort.abort(); await running; await f.dispose(); }
  }, 10000);

  it("parser wall timeout joins escaped descendants in an isolated invocation", async () => {
    const f = await fixture();
    let running: Promise<unknown> | undefined;
    try {
      running = runBoundedProcess(process.execPath, ["--jitless", f.tool], 700).catch(error => error);
      const child = await started(f.pid), tool = await started(f.parentPid);
      expect(await running).toMatchObject({ code: "MEDIA_PROCESSING_LIMIT" });
      expect(alive(child)).toBe(false); expect(alive(tool)).toBe(false);
      await writeFile(f.release, "go"); await noLateMarker(f.marker);
    } finally { await running; await f.dispose(); }
  }, 8000);

  it("recovery abort waits for all native descendants without exposing credentials", async () => {
    const f = await fixture(), abort = new AbortController();
    let running: Promise<unknown> | undefined;
    try {
      running = native(process.execPath, [f.tool], "postgres://private:secret@127.0.0.1/test", abort.signal, true).catch(error => error);
      const child = await started(f.pid), tool = await started(f.parentPid);
      abort.abort();
      expect(await running).toEqual(new Error("POSTGRES_TOOL_FAILED"));
      expect(alive(child)).toBe(false); expect(alive(tool)).toBe(false);
      await writeFile(f.release, "go"); await noLateMarker(f.marker);
    } finally { abort.abort(); await running; await f.dispose(); }
  }, 8000);

  it.each(["parser", "recovery"] as const)("%s parent-death cleanup works before the outer supervisor initiates cleanup", async mode => {
    const f = await fixture();
    // The intermediate is an ordinary Node child, not runProcessor. The parser
    // guardian alone must notice its death. The outer guardian only reaps the
    // orphan guardian; its payload stays alive until we observe descendant exit.
    let outer: ReturnType<typeof spawnSupervised> | undefined, closed: Promise<unknown> | undefined;
    try {
      await processorEntry(f, mode);
      const launcher = path.join(f.root, "launcher.cjs");
      await writeFile(launcher, `const {spawn}=require('node:child_process'); const fs=require('node:fs');
        const p=spawn(process.execPath,['--conditions=react-server','--import','tsx',${q(f.entry)}],{stdio:'ignore',env:process.env});
        const t=setInterval(()=>{if(fs.existsSync(${q(f.pid)})){clearInterval(t);p.kill('SIGKILL');}},10);
        p.on('close',()=>{const done=setInterval(()=>{if(fs.existsSync(${q(f.release)})){clearInterval(done);process.exit(0)}},10)});`);
      outer = spawnSupervised(process.execPath, [launcher], 7000, { stdio: "ignore", env: process.env });
      closed = new Promise(resolve => outer!.on("close", resolve));
      const child = await started(f.pid);
      await waitGone(child); // Outer launcher's payload is still alive here.
      expect(outer.exitCode).toBe(null);
      await writeFile(f.release, "go"); await closed; await noLateMarker(f.marker);
    } finally { if (outer) cancelSupervised(outer); await closed; await f.dispose(); }
  }, 10000);

  it("holds the local parser lock across processor death until the old tree is reaped", async () => {
    const f = await fixture(), abort = new AbortController();
    let running: Promise<string | undefined> | undefined, next: Promise<string> | undefined;
    try {
      await processorEntry(f, "parser");
      running = runProcessor({} as Claim, abort.signal, 8000, f.entry);
      const child = await started(f.pid), processor = await started(path.join(f.root, "processor"));
      const replacement = path.join(f.root, "replacement");
      // Queue a second real parser while the first is alive. It checks the old
      // PID at its first instruction after acquiring the kernel lock.
      const script = `let alive=true;try{process.kill(${child},0)}catch{alive=false}require('node:fs').writeFileSync(${q(replacement)},String(alive));`;
      next = runBoundedProcess(process.execPath, ["--jitless", "-e", script], 5000);
      await pause(50); expect(existsSync(replacement)).toBe(false);
      process.kill(processor, "SIGKILL");
      await Promise.all([running, next]);
      expect(await readFile(replacement, "utf8")).toBe("false");
      expect(alive(child)).toBe(false);
    } finally { abort.abort(); await running; await next; await f.dispose(); }
  }, 10000);

  it("cleans descendants even if the payload exits successfully", async () => {
    const f = await fixture();
    try {
      await writeFile(f.tool, `const {spawn}=require('node:child_process');const fs=require('node:fs');spawn(process.execPath,['--jitless',${q(path.join(f.root,"grandchild.cjs"))}],{stdio:'ignore',detached:true}).unref();const t=setInterval(()=>{if(fs.existsSync(${q(f.pid)})){clearInterval(t);process.exit(0)}},10);`);
      expect(await runBoundedProcess(process.execPath, ["--jitless", f.tool])).toBe("");
      expect(alive(await started(f.pid))).toBe(false);
      await writeFile(f.release, "go"); await noLateMarker(f.marker);
    } finally { await f.dispose(); }
  }, 8000);

  it("preserves bounded output, sanitized parser environment and redacted missing tools", async () => {
    process.env.NATIVE_TEST_SECRET = "must-not-reach-parser";
    try {
      expect(await runBoundedProcess(process.execPath, ["--jitless", "-e", "process.stdout.write(String(process.env.NATIVE_TEST_SECRET))"])).toBe("undefined");
      expect(await native(process.execPath, ["-e", "process.stdout.write(String(process.env.NATIVE_TEST_SECRET))"], "postgres://private:secret@127.0.0.1/test", new AbortController().signal, true)).toBe("undefined");
      await expect(runBoundedProcess(process.execPath, ["--jitless", "-e", "process.stderr.write('x'.repeat(20000));setInterval(()=>{},1000)"])).rejects.toMatchObject({ code: "MEDIA_INVALID" });
      await expect(native(process.execPath, ["-e", "process.stdout.write('x'.repeat(70000));setInterval(()=>{},1000)"], "postgres://private:secret@127.0.0.1/test", new AbortController().signal, true)).rejects.toEqual(new Error("POSTGRES_TOOL_FAILED"));
      await expect(runBoundedProcess("/nonexistent/private-secret", [])).rejects.toMatchObject({ code: "MEDIA_PARSER_UNAVAILABLE" });
    } finally { delete process.env.NATIVE_TEST_SECRET; }
  });

  it("fails closed with redacted errors when the native guardian is not packaged", async () => {
    vi.stubEnv("NATIVE_GUARDIAN_BIN", "/nonexistent/private-guardian");
    try {
      await expect(runBoundedProcess(process.execPath, ["--jitless", "-e", "process.exit(0)"])).rejects.toMatchObject({ code: "MEDIA_PARSER_UNAVAILABLE" });
      await expect(native(process.execPath, ["--version"], "postgres://private:secret@127.0.0.1/test", new AbortController().signal)).rejects.toEqual(new Error("POSTGRES_TOOL_UNAVAILABLE"));
      expect(await runProcessor({} as Claim, new AbortController().signal)).toBe("PROCESSOR_UNAVAILABLE");
    } finally { vi.stubEnv("NATIVE_GUARDIAN_BIN", guardian.binary); }
  });
});
