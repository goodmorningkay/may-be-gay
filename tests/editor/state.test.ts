import { describe, expect, it, vi } from "vitest";
import { applyPreset, changedFields, EditorCoordinator, EditorRequestError, reorderLink, validateDraft, type EditorState, type EditorTransport } from "@/domain/editor";
import { defaultProfileDocument, type ProfileDocument } from "@/domain/profile";

const uuid = "9bcefb7c-f0df-4ed5-a8f6-d93f77cb6d61";
const uuid2 = "fb21f232-b964-447c-b873-35d844735e0d";
const uuid3 = "884c11c6-38b7-44d6-a433-870725106439";
function initial(): EditorState {
  return { profileId: uuid, username: "alex", editVersion: 1, document: structuredClone(defaultProfileDocument), publishedRevisionId: null, revisions: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  let server = initial();
  const transport: EditorTransport = {
    read: vi.fn(async () => server),
    save: vi.fn(async (version, document, profileId) => {
      expect(profileId).toBe(uuid);
      expect(version).toBe(server.editVersion);
      server = { ...server, editVersion: version + 1, document };
      return server;
    }),
    action: vi.fn(async (action, version, profileId) => {
      expect(profileId).toBe(uuid);
      expect(version).toBe(server.editVersion);
      server = { ...server, editVersion: version + 1, publishedRevisionId: action === "unpublish" ? null : uuid2 };
      return server;
    }),
  };
  const coordinator = new EditorCoordinator(server, transport);
  return { coordinator, transport, setServer: (state: EditorState) => { server = state; } };
}
function edit(coordinator: EditorCoordinator, bio: string) { coordinator.edit({ ...coordinator.getSnapshot().local, bio }); }

describe("content helpers", () => {
  it("names added and removed optional fields without treating key order as a change", () => {
    const original = initial().document;
    const extended = { ...original, contact: { email: "public@example.com" }, avatarAssetId: uuid };
    expect(changedFields(original, extended)).toEqual(["contact", "avatarAssetId"]);
    expect(changedFields(extended, original)).toEqual(["contact", "avatarAssetId"]);
    const reordered = { ...extended, theme: Object.fromEntries(Object.entries(extended.theme).reverse()) as ProfileDocument["theme"] };
    expect(changedFields(extended, reordered)).toEqual([]);
  });
  it("reorders by stable UUID without changing links or mutating the original", () => {
    const document = { ...initial().document, links: [uuid, uuid2, uuid3].map((id, i) => ({ id, label: `Link ${i}`, url: "https://example.com", visible: i !== 1, icon: "github" as const })) };
    const next = reorderLink(document, uuid2, -1);
    expect(next.links.map(link => link.id)).toEqual([uuid2, uuid, uuid3]);
    expect(next.links[0]).toBe(document.links[1]);
    expect(document.links.map(link => link.id)).toEqual([uuid, uuid2, uuid3]);
    expect(reorderLink(next, uuid2, -1)).toBe(next);
    expect(reorderLink(next, uuid3, 1)).toBe(next);
    expect(reorderLink(next, "missing", 1)).toBe(next);
    expect(reorderLink(next, uuid2, 1)).toEqual(document);
  });
  it("applies every preset while preserving content, media, metadata, layout and font", () => {
    const document: ProfileDocument = { ...initial().document, avatarAssetId: uuid, backgroundAssetId: uuid2, music: { assetId: uuid3, attribution: "My recording" }, contact: { email: "public@example.com" },
      theme: { preset: "midnight", font: "serif", layout: "split", colors: { ink: "#ffffff" }, background: { kind: "solid", color: "#000000" }, overlay: "dark", spacing: "airy", button: "pill" } };
    for (const preset of ["paper", "midnight", "blush", "forest", "sunset", "ocean"] as const) {
      const next = applyPreset(document, preset);
      expect({ ...next, theme: document.theme }).toEqual(document);
      expect(next.theme).toEqual({ preset, layout: "split", font: "serif" });
      expect(changedFields(document, next)).toEqual(["theme"]);
    }
  });
  it("reports addressable field errors without allowing invalid drafts into the renderer", () => {
    const document = { ...initial().document, displayName: "", contact: { email: "bad" }, music: { assetId: uuid, attribution: "" }, theme: { ...initial().document.theme, colors: { ink: "#bad" } }, links: [{ id: uuid, label: "", url: "javascript:alert(1)", visible: true }] };
    const result = validateDraft(document);
    expect(result.document).toBeNull();
    expect(Object.keys(result.errors)).toEqual(expect.arrayContaining(["displayName", "contact.email", "music.attribution", "theme.colors.ink", "links.0.label", "links.0.url"]));
  });
});

describe("serialized editor saves", () => {
  it("settles a save when JSONB and schema parsing return different property order", async () => {
    const { coordinator: c, transport } = harness();
    vi.mocked(transport.save).mockImplementationOnce(async (version, document) => ({ ...initial(), editVersion: version + 1,
      document: { ...document, theme: Object.fromEntries(Object.entries(document.theme).reverse()) as ProfileDocument["theme"] } }));
    edit(c, "One edit");
    expect(await c.flush()).toBe(true);
    expect(transport.save).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().dirty).toBe(false);
  });
  it("retains the original profile precondition after a silent account switch rejection", async () => {
    const { coordinator: c, transport } = harness();
    vi.mocked(transport.save).mockRejectedValueOnce(new EditorRequestError(409, "ACCOUNT_CHANGED", "Open the original account."));
    edit(c, "Private original input");
    expect(await c.flush()).toBe(false);
    expect(c.getSnapshot().local.bio).toBe("Private original input");
    expect(c.getSnapshot().server.profileId).toBe(uuid);
    expect(transport.save).toHaveBeenCalledWith(1, expect.objectContaining({ bio: "Private original input" }), uuid);
    expect(transport.read).not.toHaveBeenCalled();
    expect(await c.perform("publish")).toBe(false);
    expect(transport.action).not.toHaveBeenCalled();
    // A deliberate retry keeps the retained identity; it cannot adopt B's.
    expect(await c.retry()).toBe(true);
    expect(vi.mocked(transport.save).mock.calls.map(call => call[2])).toEqual([uuid, uuid]);
  });
  it("saves edits made in flight against the returned version without replacing local input", async () => {
    const { coordinator: c, transport } = harness();
    const request = deferred<EditorState>();
    vi.mocked(transport.save).mockImplementationOnce(() => request.promise);
    edit(c, "first"); const save = c.flush();
    edit(c, "second");
    expect(transport.save).toHaveBeenCalledTimes(1);
    request.resolve({ ...initial(), editVersion: 2, document: { ...initial().document, bio: "first" } });
    vi.mocked(transport.save).mockImplementationOnce(async (version, document) => ({ ...initial(), editVersion: version + 1, document }));
    expect(await save).toBe(true);
    expect(vi.mocked(transport.save).mock.calls.map(([version, document]) => [version, document.bio])).toEqual([[1, "first"], [2, "second"]]);
    expect(c.getSnapshot().local.bio).toBe("second");
    expect(c.getSnapshot().server.editVersion).toBe(3);
    expect(c.getSnapshot().dirty).toBe(false);
  });
  it("coalesces simultaneous flush calls into a single writer", async () => {
    const { coordinator: c, transport } = harness(); const request = deferred<EditorState>();
    vi.mocked(transport.save).mockImplementationOnce(() => request.promise);
    edit(c, "pending"); const first = c.flush(), second = c.flush(), third = c.flush();
    expect(transport.save).toHaveBeenCalledTimes(1);
    request.resolve({ ...initial(), editVersion: 2, document: c.getSnapshot().local });
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
    expect(transport.save).toHaveBeenCalledTimes(1);
  });
  it("keeps invalid edits made in flight and the last valid preview", async () => {
    const { coordinator: c, transport } = harness(); const request = deferred<EditorState>();
    vi.mocked(transport.save).mockImplementationOnce(() => request.promise);
    edit(c, "valid"); const save = c.flush();
    c.edit({ ...c.getSnapshot().local, displayName: "" });
    request.resolve({ ...initial(), editVersion: 2, document: { ...initial().document, bio: "valid" } });
    expect(await save).toBe(false);
    expect(c.getSnapshot().local.displayName).toBe("");
    expect(c.getSnapshot().preview.displayName).toBe("Your name");
    expect(c.getSnapshot().errors.displayName).toBeTruthy();
    expect(transport.save).toHaveBeenCalledTimes(1);
  });
  it("blocks invalid saves/publication and resumes when corrected", async () => {
    const { coordinator: c, transport } = harness();
    c.edit({ ...c.getSnapshot().local, displayName: "" });
    expect(await c.flush()).toBe(false); expect(await c.perform("publish")).toBe(false);
    expect(transport.save).not.toHaveBeenCalled(); expect(transport.action).not.toHaveBeenCalled();
    c.edit({ ...c.getSnapshot().local, displayName: "Alex" });
    expect(await c.flush()).toBe(true);
  });
  it("does not retry failed requests until explicitly requested", async () => {
    const { coordinator: c, transport } = harness();
    vi.mocked(transport.save).mockRejectedValueOnce(new EditorRequestError(0, "NETWORK_UNAVAILABLE", "Offline"));
    edit(c, "retained"); expect(await c.flush()).toBe(false);
    edit(c, "still retained"); expect(await c.flush()).toBe(false);
    expect(transport.save).toHaveBeenCalledTimes(1);
    expect(await c.retry()).toBe(true);
    expect(c.getSnapshot().server.document.bio).toBe("still retained");
  });
  it("retains local input and does not redirect on expired sessions", async () => {
    const { coordinator: c, transport } = harness();
    vi.mocked(transport.save).mockRejectedValueOnce(new EditorRequestError(401, "SIGN_IN_REQUIRED", "Sign in"));
    edit(c, "private unsaved input"); await c.flush();
    expect(c.getSnapshot().local.bio).toBe("private unsaved input");
    expect(c.getSnapshot().problem?.status).toBe(401);
    expect(c.getSnapshot().server.editVersion).toBe(1);
  });
  it("ignores an in-flight response after disposal", async () => {
    const { coordinator: c, transport } = harness(); const request = deferred<EditorState>();
    vi.mocked(transport.save).mockImplementationOnce(() => request.promise);
    edit(c, "pending"); const save = c.flush(); c.dispose();
    request.resolve({ ...initial(), editVersion: 2, document: c.getSnapshot().local });
    expect(await save).toBe(false); expect(c.getSnapshot().server.editVersion).toBe(1);
  });
  it("checks account identity before retrying after a session expires", async () => {
    const { coordinator: c, transport, setServer } = harness();
    vi.mocked(transport.save).mockRejectedValueOnce(new EditorRequestError(401, "SIGN_IN_REQUIRED", "Sign in"));
    edit(c, "private original draft"); await c.flush();
    setServer({ ...initial(), profileId: uuid2, username: "someone-else" });
    expect(await c.retry()).toBe(false);
    expect(c.getSnapshot().problem?.code).toBe("ACCOUNT_CHANGED");
    expect(c.getSnapshot().local.bio).toBe("private original draft");
    expect(transport.save).toHaveBeenCalledTimes(1);
    setServer(initial()); expect(await c.retry()).toBe(true);
  });
  it("compares a changed server version before retrying after session expiry", async () => {
    const { coordinator: c, transport, setServer } = harness();
    vi.mocked(transport.save).mockRejectedValueOnce(new EditorRequestError(401, "SIGN_IN_REQUIRED", "Sign in"));
    edit(c, "mine"); await c.flush(); setServer({ ...initial(), editVersion: 4 });
    expect(await c.retry()).toBe(false);
    expect(c.getSnapshot().conflict?.latest?.editVersion).toBe(4);
    expect(c.getSnapshot().local.bio).toBe("mine");
    expect(transport.save).toHaveBeenCalledTimes(1);
  });
});

describe("conflicts and response freshness", () => {
  async function conflict() {
    const h = harness(); const latest = { ...initial(), editVersion: 4, document: { ...initial().document, bio: "other tab" } };
    h.setServer(latest);
    vi.mocked(h.transport.save).mockRejectedValueOnce(new EditorRequestError(409, "EDIT_VERSION_CONFLICT", "Changed"));
    edit(h.coordinator, "my input"); await h.coordinator.flush();
    return { ...h, latest };
  }
  it("fetches a comparison on 409 without silently retrying or losing local input", async () => {
    const { coordinator: c, transport, latest } = await conflict();
    expect(c.getSnapshot().conflict?.latest).toEqual(latest);
    expect(c.getSnapshot().server.editVersion).toBe(1);
    expect(c.getSnapshot().local.bio).toBe("my input");
    expect(await c.retry()).toBe(false); expect(await c.perform("publish")).toBe(false);
    expect(transport.save).toHaveBeenCalledTimes(1); expect(transport.action).not.toHaveBeenCalled();
  });
  it("requires explicit resolution to save the local document against the compared version", async () => {
    const { coordinator: c, transport } = await conflict();
    edit(c, "my continued edits"); c.resolveConflict("local");
    expect(c.getSnapshot().local.bio).toBe("my continued edits");
    expect(transport.save).toHaveBeenCalledTimes(1);
    expect(await c.flush()).toBe(true);
    expect(vi.mocked(transport.save).mock.calls[1][0]).toBe(4);
  });
  it("can deliberately discard local input and load the compared server draft", async () => {
    const { coordinator: c, transport, latest } = await conflict();
    c.resolveConflict("server");
    expect(c.getSnapshot().local).toEqual(latest.document); expect(c.getSnapshot().dirty).toBe(false);
    expect(await c.flush()).toBe(true); expect(transport.save).toHaveBeenCalledTimes(1);
  });
  it("keeps conflict unresolved when latest state cannot be read and supports explicit refresh", async () => {
    const { coordinator: c, transport } = harness();
    vi.mocked(transport.save).mockRejectedValueOnce(new EditorRequestError(409, "EDIT_VERSION_CONFLICT", "Changed"));
    vi.mocked(transport.read).mockRejectedValueOnce(new Error("offline"));
    edit(c, "mine"); await c.flush(); c.resolveConflict("server");
    expect(c.getSnapshot().local.bio).toBe("mine"); expect(c.getSnapshot().conflict?.latest).toBeNull();
    await c.refreshConflict(); expect(c.getSnapshot().conflict?.latest).not.toBeNull();
  });
  it("rejects stale save responses without changing the newer local input", async () => {
    const { coordinator: c, transport } = harness();
    vi.mocked(transport.save).mockResolvedValueOnce(initial()); edit(c, "mine");
    expect(await c.flush()).toBe(false);
    expect(c.getSnapshot().local.bio).toBe("mine"); expect(c.getSnapshot().problem?.code).toBe("STALE_RESPONSE");
    expect(c.getSnapshot().server.editVersion).toBe(1); expect(transport.save).toHaveBeenCalledTimes(1);
  });
  it("rejects another profile identity in a response", async () => {
    const { coordinator: c, transport } = harness();
    vi.mocked(transport.save).mockResolvedValueOnce({ ...initial(), profileId: uuid2, editVersion: 2 });
    edit(c, "mine"); await c.flush(); expect(c.getSnapshot().server.profileId).toBe(uuid);
    expect(c.getSnapshot().problem?.code).toBe("STALE_RESPONSE");
  });
  it("rejects out-of-order comparison responses", async () => {
    const { coordinator: c, transport } = await conflict();
    const older = deferred<EditorState>(), newer = deferred<EditorState>();
    vi.mocked(transport.read).mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise);
    const first = c.refreshConflict(), second = c.refreshConflict();
    newer.resolve({ ...initial(), editVersion: 6 }); await second;
    older.resolve({ ...initial(), editVersion: 5 }); await first;
    expect(c.getSnapshot().conflict?.latest?.editVersion).toBe(6);
  });
});

describe("publication serialization", () => {
  it("flushes the newest valid pending input before publish with the returned version", async () => {
    const { coordinator: c, transport } = harness(); const request = deferred<EditorState>();
    vi.mocked(transport.save).mockImplementationOnce(() => request.promise);
    edit(c, "first"); const saving = c.flush(); edit(c, "latest");
    const publication = c.perform("publish");
    expect(transport.action).not.toHaveBeenCalled();
    request.resolve({ ...initial(), editVersion: 2, document: { ...initial().document, bio: "first" } });
    vi.mocked(transport.save).mockImplementationOnce(async (version, document) => ({ ...initial(), editVersion: version + 1, document }));
    vi.mocked(transport.action).mockImplementationOnce(async (_action, version) => ({ ...initial(), editVersion: version + 1, document: c.getSnapshot().local, publishedRevisionId: uuid2 }));
    expect(await publication).toBe(true); await saving;
    expect(transport.action).toHaveBeenCalledWith("publish", 3, uuid);
    expect(c.getSnapshot().server.document.bio).toBe("latest"); expect(c.getSnapshot().server.editVersion).toBe(4);
  });
  it("blocks publication after a save failure and leaves the draft editable", async () => {
    const { coordinator: c, transport } = harness();
    vi.mocked(transport.save).mockRejectedValueOnce(new EditorRequestError(422, "INVALID_PROFILE_MEDIA", "Invalid media"));
    edit(c, "mine"); expect(await c.perform("publish")).toBe(false);
    expect(transport.action).not.toHaveBeenCalled(); expect(c.getSnapshot().busyAction).toBe(false);
    expect(c.getSnapshot().local.bio).toBe("mine");
  });
  it("keeps the old publication and saved draft when publication fails", async () => {
    const old = { ...initial(), publishedRevisionId: uuid2 };
    const { transport } = harness(); const c = new EditorCoordinator(old, transport);
    vi.mocked(transport.action).mockRejectedValueOnce(new EditorRequestError(503, "MEDIA_PROMOTION_FAILED", "Try again"));
    expect(await c.perform("publish")).toBe(false);
    expect(c.getSnapshot().server.publishedRevisionId).toBe(uuid2);
    expect(c.getSnapshot().local).toEqual(old.document);
  });
  it("serializes restore with saves and uses the returned replacement draft", async () => {
    const { coordinator: c, transport } = harness(); const request = deferred<EditorState>();
    vi.mocked(transport.action).mockImplementationOnce(() => request.promise);
    edit(c, "new draft"); const restoration = c.perform({ restore: uuid3 });
    await vi.waitFor(() => expect(transport.action).toHaveBeenCalled());
    expect(transport.action).toHaveBeenCalledWith({ restore: uuid3 }, 2, uuid);
    expect(await c.perform("publish")).toBe(false);
    edit(c, "edit while restoring is ignored");
    request.resolve({ ...initial(), editVersion: 3, document: { ...initial().document, bio: "restored" }, publishedRevisionId: uuid2 });
    expect(await restoration).toBe(true); expect(c.getSnapshot().local.bio).toBe("restored");
    expect(c.getSnapshot().dirty).toBe(false);
  });
  it("unpublish advances the version used by subsequent edits", async () => {
    const { coordinator: c, transport } = harness();
    expect(await c.perform("unpublish")).toBe(true);
    edit(c, "next"); await c.flush();
    expect(transport.save).toHaveBeenLastCalledWith(2, expect.objectContaining({ bio: "next" }), uuid);
  });
});
