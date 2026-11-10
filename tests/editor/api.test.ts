import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorRequestError } from "@/domain/editor";
import { defaultProfileDocument } from "@/domain/profile";
import { checked, editorTransport, mediaListSchema, requestJson } from "@/components/editor/api";

afterEach(() => vi.unstubAllGlobals());
const uuid = "9bcefb7c-f0df-4ed5-a8f6-d93f77cb6d61";
const responseState = { profileId: uuid, username: "alex", editVersion: 2, document: defaultProfileDocument, publishedRevisionId: null, revisions: [] };
describe("private editor HTTP boundary", () => {
  it("uses no-store, same-origin credentials and bounded error projections", async () => {
    const fetch = vi.fn(async () => Response.json({ error: { code: "REQUEST_FAILED", message: "Try again" }, privateDebug: "never expose" }, { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    await expect(requestJson("/api/profile")).rejects.toMatchObject({ status: 500, code: "REQUEST_FAILED", message: "Try again" });
    expect(fetch).toHaveBeenCalledWith("/api/profile", expect.objectContaining({ cache: "no-store", credentials: "same-origin", redirect: "error" }));
  });
  it("does not expose malformed or oversized server exception values", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "stack trace", message: "private detail".repeat(100) } }, { status: 500 })));
    await expect(requestJson("/api/profile")).rejects.toMatchObject({ code: "REQUEST_FAILED", message: "Unable to complete the request. Your input is retained." });
  });
  it("explains expired sessions without redirecting away from retained input", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "SIGN_IN_REQUIRED", message: "Please sign in." } }, { status: 401 })));
    await expect(requestJson("/api/profile")).rejects.toMatchObject({ status: 401, message: expect.stringContaining("new tab") });
  });
  it("distinguishes network failure and preserves aborts", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("private network details")).mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    vi.stubGlobal("fetch", fetch);
    await expect(requestJson("/api/profile")).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    await expect(requestJson("/api/media")).rejects.toMatchObject({ name: "AbortError" });
  });
  it("writes only the documented version and document shape", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(responseState)); vi.stubGlobal("fetch", fetch);
    expect(await editorTransport.save(1, defaultProfileDocument, uuid)).toEqual(responseState);
    const options = fetch.mock.calls[0][1] as RequestInit;
    expect(options.method).toBe("PUT");
    expect(new Headers(options.headers).get("x-editor-profile")).toBe(uuid);
    expect(JSON.parse(options.body as string)).toEqual({ expectedVersion: 1, document: defaultProfileDocument });
  });
  it("uses the distinct publish, unpublish and restore body contracts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(responseState)); vi.stubGlobal("fetch", fetch);
    await editorTransport.action("publish", 3, uuid); await editorTransport.action("unpublish", 4, uuid); await editorTransport.action({ restore: uuid }, 5, uuid);
    for (const [, init] of fetch.mock.calls) expect(new Headers(init?.headers).get("x-editor-profile")).toBe(uuid);
    expect(fetch.mock.calls.map(([path, init]) => [path, JSON.parse((init as RequestInit).body as string)])).toEqual([
      ["/api/profile/publish", { expectedVersion: 3 }], ["/api/profile/unpublish", {}], [`/api/profile/revisions/${uuid}/restore`, { expectedVersion: 5 }],
    ]);
  });
  it("rejects invalid successful draft responses before they enter the renderer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...responseState, document: { ...defaultProfileDocument, links: [{ id: uuid, label: "Bad", url: "javascript:alert(1)", visible: true }] } })));
    await expect(editorTransport.read()).rejects.toBeInstanceOf(EditorRequestError);
    await expect(editorTransport.read()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("parses the actual media listing including pending states and real usage", () => {
    expect(checked(mediaListSchema, { assets: [{ id: uuid, kind: "image", state: "quarantined", contentType: null, bytes: null, width: null, height: null, durationMs: null, createdAt: "2026-11-10T15:00:00.000Z" }],
      usage: { chargedBytes: 12582912, privateBytes: 0, publicReservedBytes: 0 }, quota: { limitBytes: 104857600, uploadsPaused: false, globalCapacityAvailable: true } }).usage.chargedBytes).toBe(12582912);
  });
});
