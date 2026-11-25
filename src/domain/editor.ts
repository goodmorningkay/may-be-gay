import { profileDocumentSchema, type ProfileDocument } from "./profile";

export type EditorState = {
  profileId: string;
  username: string;
  editVersion: number;
  document: ProfileDocument;
  publishedRevisionId: string | null;
  revisions: { id: string; revisionNumber: number; createdAt: string }[];
};
export type EditorAction = "publish" | "unpublish" | { restore: string };
export type FieldErrors = Record<string, string>;
export type EditorTransport = {
  read(): Promise<EditorState>;
  save(version: number, document: ProfileDocument, profileId: string): Promise<EditorState>;
  action(action: EditorAction, version: number, profileId: string): Promise<EditorState>;
};
export class EditorRequestError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function validateDraft(document: ProfileDocument): { document: ProfileDocument | null; errors: FieldErrors } {
  const result = profileDocumentSchema.safeParse(document);
  if (result.success) return { document: result.data, errors: {} };
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) errors[issue.path.join(".")] ??= issue.message;
  return { document: null, errors };
}
export function reorderLink(document: ProfileDocument, id: string, direction: -1 | 1): ProfileDocument {
  const index = document.links.findIndex(link => link.id === id), target = index + direction;
  if (index < 0 || target < 0 || target >= document.links.length) return document;
  const links = [...document.links];
  [links[index], links[target]] = [links[target], links[index]];
  return { ...document, links };
}
/** Presets replace appearance only. Auth identity is never a content source. */
export function applyPreset(document: ProfileDocument, preset: ProfileDocument["theme"]["preset"]): ProfileDocument {
  return { ...document, theme: { preset, layout: document.theme.layout, font: document.theme.font } };
}
export function changedFields(a: ProfileDocument, b: ProfileDocument): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key =>
    !deepEqual(a[key as keyof ProfileDocument], b[key as keyof ProfileDocument]));
}
// JSONB and schema parsing can return the same fields in a different order.
// Equality must compare content or an acknowledged save can loop forever.
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).filter((k) => aObj[k] !== undefined);
  const bKeys = Object.keys(bObj).filter((k) => bObj[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(bObj, key) && deepEqual(aObj[key], bObj[key]));
}
const equal = (a: ProfileDocument, b: ProfileDocument) => deepEqual(a, b);
type EditorSnapshot = {
  server: EditorState;
  local: ProfileDocument;
  preview: ProfileDocument;
  errors: FieldErrors;
  dirty: boolean;
  saving: boolean;
  busyAction: boolean;
  problem: EditorRequestError | null;
  conflict: { base: EditorState; latest: EditorState | null } | null;
  notice: string;
};

/** One writer and one version chain. No timers, browser storage or implicit conflict retries. */
export class EditorCoordinator {
  private snapshot: EditorSnapshot;
  private listeners = new Set<() => void>();
  private active: Promise<void> | null = null;
  private disposed = false;
  private comparisonRequest = 0;
  constructor(initial: EditorState, private transport: EditorTransport) {
    this.snapshot = { server: initial, local: initial.document, preview: initial.document, errors: {}, dirty: false,
      saving: false, busyAction: false, problem: null, conflict: null, notice: "" };
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  // Unmounted requests may finish on the server; their responses never change this editor.
  dispose() { this.disposed = true; this.listeners.clear(); }
  private update(patch: Partial<EditorSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach(listener => listener());
  }
  edit(document: ProfileDocument) {
    if (this.disposed || this.snapshot.busyAction) return;
    const valid = validateDraft(document);
    this.update({ local: document, preview: valid.document ?? this.snapshot.preview, errors: valid.errors,
      dirty: !equal(document, this.snapshot.server.document), notice: "" });
  }
  private accept(next: EditorState, replaceLocal: boolean) {
    const current = this.snapshot;
    if (next.profileId !== current.server.profileId || next.username !== current.server.username || next.editVersion <= current.server.editVersion) {
      throw new EditorRequestError(502, "STALE_RESPONSE", "An outdated response was ignored. Refresh the server comparison before retrying.");
    }
    const local = replaceLocal ? next.document : current.local;
    const valid = validateDraft(local);
    this.update({ server: next, local, preview: valid.document ?? current.preview, errors: valid.errors, dirty: !equal(local, next.document) });
  }
  private async fail(error: unknown) {
    if (this.disposed) return;
    const problem = error instanceof EditorRequestError ? error : new EditorRequestError(0, "NETWORK_UNAVAILABLE", "Connection unavailable. Your input remains in this tab.");
    this.update({ problem });
    if (problem.code === "EDIT_VERSION_CONFLICT" || problem.code === "STALE_RESPONSE") {
      this.update({ conflict: { base: this.snapshot.server, latest: null } });
      await this.refreshConflict();
    }
  }
  async refreshConflict() {
    if (!this.snapshot.conflict || this.disposed) return;
    const request = ++this.comparisonRequest;
    try {
      const latest = await this.transport.read();
      if (this.disposed || !this.snapshot.conflict || request !== this.comparisonRequest) return;
      if (latest.profileId !== this.snapshot.server.profileId || latest.username !== this.snapshot.server.username || latest.editVersion < this.snapshot.server.editVersion) {
        throw new EditorRequestError(502, "STALE_RESPONSE", "The server comparison was outdated. Refresh it again.");
      }
      this.update({ conflict: { ...this.snapshot.conflict, latest } });
    } catch (error) {
      if (this.disposed || !this.snapshot.conflict || request !== this.comparisonRequest) return;
      this.update({ problem: error instanceof EditorRequestError ? error : new EditorRequestError(0, "NETWORK_UNAVAILABLE", "Could not load the latest server draft. Your input is retained.") });
    }
  }
  /** Deliberate choice only; retaining local input does not itself send a write. */
  resolveConflict(choice: "local" | "server") {
    const latest = this.snapshot.conflict?.latest;
    if (!latest || this.snapshot.saving || this.snapshot.busyAction) return;
    const local = choice === "local" ? this.snapshot.local : latest.document;
    const valid = validateDraft(local);
    this.update({ server: latest, local, preview: valid.document ?? latest.document, errors: valid.errors, dirty: !equal(local, latest.document),
      conflict: null, problem: null, notice: choice === "local" ? "Your input will replace the compared server draft when it autosaves. Further concurrent edits will cause another conflict." : "Loaded the compared server draft." });
  }
  async flush(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.active) { await this.active; return this.flush(); }
    if (this.snapshot.problem || this.snapshot.conflict || Object.keys(this.snapshot.errors).length) return false;
    if (!this.snapshot.dirty) return true;
    this.active = this.drain();
    try { await this.active; } finally { this.active = null; }
    return !this.disposed && !this.snapshot.problem && !this.snapshot.conflict && !this.snapshot.dirty && !Object.keys(this.snapshot.errors).length;
  }
  private async drain() {
    this.update({ saving: true });
    try {
      while (!this.disposed && this.snapshot.dirty && !Object.keys(this.snapshot.errors).length && !this.snapshot.conflict && !this.snapshot.problem) {
        const valid = validateDraft(this.snapshot.local).document;
        if (!valid) break;
        const result = await this.transport.save(this.snapshot.server.editVersion, valid, this.snapshot.server.profileId);
        if (this.disposed) return;
        this.accept(result, false);
      }
    } catch (error) { await this.fail(error); }
    finally { this.update({ saving: false }); }
  }
  async retry() {
    if (this.snapshot.conflict || this.snapshot.busyAction) return false;
    // Authentication may have changed while sign-in was open in another tab.
    // Compare identity and version before resuming a private write after expiry.
    if (this.snapshot.problem?.status === 401) {
      try {
        const latest = await this.transport.read();
        if (this.disposed) return false;
        if (latest.profileId !== this.snapshot.server.profileId || latest.username !== this.snapshot.server.username) {
          this.update({ problem: new EditorRequestError(401, "ACCOUNT_CHANGED", "Sign in to the original account to resume this draft. Your local input has not been sent to the other account.") });
          return false;
        }
        if (latest.editVersion !== this.snapshot.server.editVersion) {
          this.update({ problem: new EditorRequestError(409, "EDIT_VERSION_CONFLICT", "The server changed while you were signed out. Compare before saving."), conflict: { base: this.snapshot.server, latest } });
          return false;
        }
      } catch (error) { await this.fail(error); return false; }
    }
    this.update({ problem: null, notice: "" });
    return this.flush();
  }
  async perform(action: EditorAction): Promise<boolean> {
    if (this.snapshot.busyAction || this.disposed) return false;
    this.update({ busyAction: true, notice: "" });
    try {
      if (!await this.flush()) return false;
      const next = await this.transport.action(action, this.snapshot.server.editVersion, this.snapshot.server.profileId);
      if (this.disposed) return false;
      this.accept(next, true);
      this.update({ notice: action === "publish" ? "Published. Your public page now uses this saved draft." : action === "unpublish" ? "Unpublished. Your draft and retained history are still available." : "Revision restored as a new publication and draft." });
      return true;
    } catch (error) { await this.fail(error); return false; }
    finally { this.update({ busyAction: false }); }
  }
}
