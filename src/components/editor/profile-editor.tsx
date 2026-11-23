/* eslint-disable @next/next/no-html-link-for-pages -- Full document navigation lets beforeunload protect private unsaved input. */
"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { EditorCoordinator, changedFields, type EditorAction, type EditorState } from "@/domain/editor";
import brand from "@/components/brand.module.css";
import type { PublicMediaMap } from "@/domain/media";
import { editorTransport } from "./api";
import { AppearanceFields } from "./appearance-fields";
import { AboutFields, DiscoveryFields, LinkFields, type LinkEdit } from "./content-fields";
import { EmbedFields } from "./embed-fields";
import { EditorIcon } from "./editor-icon";
import { MediaLibrary } from "./media-library";
import { LivePreview } from "./live-preview";
import styles from "./editor.module.css";

const sections = {
  identity: "About you",
  links: "Links",
  embeds: "Embeds",
  appearance: "Appearance",
  media: "Media",
  discovery: "Discovery",
  history: "Publishing",
} as const;
type Section = keyof typeof sections;
const sectionIds = Object.keys(sections) as Section[];

function sectionForField(field: string): Section {
  const root = field.split(".")[0];
  if (root === "links") return "links";
  if (root === "embeds") return "embeds";
  if (root === "theme") return "appearance";
  if (root === "avatarAssetId" || root === "backgroundAssetId" || root === "music" || root === "clickToEnter") return "media";
  if (root === "pageTitle" || root === "pageDescription" || root === "allowIndexing") return "discovery";
  return "identity";
}

export function ProfileEditor({ initial, siteDomain }: { initial: EditorState; siteDomain: string }) {
  const [coordinator] = useState(() => new EditorCoordinator(initial, editorTransport));
  const [editorProfileId] = useState(initial.profileId);
  const state = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot);
  const [media, setMedia] = useState<PublicMediaMap>({});
  const [section, setSection] = useState<Section>("identity");
  const [mobilePreview, setMobilePreview] = useState(false);
  const [linkEdit, setLinkEdit] = useState<LinkEdit | null>(null);
  const [size, setSize] = useState<"mobile" | "desktop">("mobile");
  const [online, setOnline] = useState(true);
  const [confirm, setConfirm] = useState<EditorAction | "server" | "local" | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const setDocument = useCallback((document: EditorState["document"]) => coordinator.edit(document), [coordinator]);
  const errorCount = Object.keys(state.errors).length;
  const blocked = state.busyAction || Boolean(state.problem || state.conflict) || errorCount > 0;
  // Delayed cleanup also supports React's development effect replay without disposing the live coordinator.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; queueMicrotask(() => { if (!mounted.current) coordinator.dispose(); }); };
  }, [coordinator]);
  useEffect(() => {
    if (!state.dirty || blocked || !online || state.saving) return;
    const timer = setTimeout(() => { void coordinator.flush(); }, 800);
    return () => clearTimeout(timer);
  }, [coordinator, state.local, state.dirty, state.saving, blocked, online]);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    // This private page just loaded from the server. Some browsers report
    // offline on local/VPN networks despite that successful connection. Observe
    // later transitions; actual failed saves still retain input and offer retry.
    window.addEventListener("online", update); window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      const current = coordinator.getSnapshot();
      if (current.dirty || current.saving || current.busyAction || current.conflict) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [coordinator]);
  useEffect(() => { if (confirm) dialog.current?.showModal(); else dialog.current?.close(); }, [confirm]);

  function downloadDraft() {
    const blob = new Blob([JSON.stringify(state.local, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), anchor = window.document.createElement("a");
    anchor.href = url; anchor.download = `${state.server.username}-private-draft.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function confirmAction() {
    const action = confirm; setConfirm(null);
    if (action === "local" || action === "server") coordinator.resolveConflict(action);
    else if (action) await coordinator.perform(action);
  }
  function focusField(field: string) {
    const destination = sectionForField(field);
    setSection(destination);
    setMobilePreview(false);
    if (destination === "links") {
      const [, position, input] = field.split(".");
      const id = state.local.links[Number(position)]?.id;
      if (id) {
        setLinkEdit({ id, field: input === "url" || input === "icon" ? input : "label" });
        return;
      }
    }
    requestAnimationFrame(() => {
      const target = document.getElementById(`field-${field}`) ?? document.getElementById(`panel-${destination}`);
      target?.focus();
    });
  }

  const status = state.conflict ? "Conflict · your input is retained" : !online ? "Offline · input retained in this tab" : state.busyAction ? "Applying publication change…" : state.saving ? "Saving draft…" : state.problem ? "Save or action needs attention" : errorCount ? "Not saved · check the fields below" : state.dirty ? "Unsaved changes" : "Draft saved";
  const publicUrl = `https://${state.server.username}.${siteDomain}`;
  const published = Boolean(state.server.publishedRevisionId);
  const restoreRevision = confirm && typeof confirm === "object" ? state.server.revisions.find(revision => revision.id === confirm.restore) : null;
  const fieldProps = { document: state.local, errors: state.errors, onChange: setDocument };

  return <div className={`${brand.dark} ${styles.editor}`}>
    <div className={styles.container}>
      <header className={styles.header}>
        <a className={brand.wordmark} href="/"><span className={brand.brandMark} aria-hidden="true" />may-be.gay</a>
        <a className={styles.button} href="/account">Account</a>
      </header>
      <main>
        <div className={styles.titleRow}>
          <div>
            <h1>Edit your page</h1>
            <p className={styles.address}>{state.server.username}.{siteDomain}</p>
          </div>
          <div className={styles.saveBar}>
            <p role="status" className={styles.saveStatus} data-saved={status === "Draft saved"}>
              {status}{status === "Draft saved" && <span className={styles.srOnly}> · version {state.server.editVersion}</span>}
            </p>
            <div className={styles.saveActions}>
              <button type="button" disabled={blocked || state.saving || !online || !state.dirty} onClick={() => void coordinator.flush()}>Save now</button>
              <button type="button" className={styles.primary} disabled={blocked || !online} onClick={() => setConfirm("publish")}>{published ? "Publish changes" : "Publish page"}</button>
            </div>
          </div>
        </div>
        {state.notice ? <p role="status" className={styles.feedback}>{state.notice}</p> : null}
        {state.problem ? <div className={styles.errorBox} role="status"><strong>{state.problem.status === 401 ? "Sign in again to continue" : "Your input is still here"}</strong>
        <p>{state.problem.message} <small>({state.problem.code})</small></p><p>Publication failures leave the previous public page intact. An interrupted request may have completed; a version conflict will be compared before another write.</p>
        <div className={styles.inlineActions}>{state.problem.status === 401 ? <a href="/sign-in?returnTo=%2Feditor" target="_blank" rel="noopener noreferrer">Sign in in a new tab</a> : null}
          {!state.conflict ? <button type="button" disabled={state.busyAction || state.saving || !online} onClick={() => void coordinator.retry()}>Retry saving / resume editing</button> : null}
          <button type="button" onClick={downloadDraft}>Download my local draft</button></div></div> : null}
        {state.conflict ? <section className={styles.conflict} aria-labelledby="conflict-title"><h2 id="conflict-title">Another edit reached the server first.</h2>
        <p>Your local input has been kept in this tab. Saving and publishing are paused. Compare the drafts before choosing which complete draft to keep; there is no automatic merge.</p>
        <p>Your starting version: {state.conflict.base.editVersion}. Latest server version: {state.conflict.latest?.editVersion ?? "not loaded"}.</p>
          {state.conflict.latest ? <>
          <p>Server changed since your starting version: {changedFields(state.conflict.base.document, state.conflict.latest.document).join(", ") || "publication state or version only"}.</p>
          <p>Your input differs from the latest server draft in: {changedFields(state.local, state.conflict.latest.document).join(", ") || "no document fields"}.</p>
          <div className={styles.twoColumns}><details><summary>Your complete local input</summary><pre tabIndex={0}>{JSON.stringify(state.local, null, 2)}</pre></details>
            <details><summary>Latest complete server draft</summary><pre tabIndex={0}>{JSON.stringify(state.conflict.latest.document, null, 2)}</pre></details></div>
          <div className={styles.inlineActions}><button type="button" onClick={() => setConfirm("local")}>Keep my input and replace server draft</button><button type="button" onClick={() => setConfirm("server")}>Load server draft and discard my input</button></div>
        </> : <p>The latest draft could not be loaded. Your local input is retained; retry the comparison after reconnecting or signing in.</p>}
        <div className={styles.inlineActions}><button type="button" disabled={!online} onClick={() => void coordinator.refreshConflict()}>Refresh comparison</button><button type="button" onClick={downloadDraft}>Download my local draft</button></div>
      </section> : null}
        {errorCount > 0 && <div className={styles.errorBox}>
          <strong>{errorCount} {errorCount === 1 ? "field needs" : "fields need"} attention before saving or publishing.</strong>
          <ul>{Object.entries(state.errors).map(([field, message]) =>
            <li key={field}><a href={`#field-${field}`} onClick={e => { e.preventDefault(); focusField(field); }}>{field}: {message}</a></li>
          )}</ul>
        </div>}
        <div className={`${styles.segmented} ${styles.mobileTabs}`} role="group" aria-label="Editor view">
          <button type="button" aria-pressed={!mobilePreview} onClick={() => setMobilePreview(false)}>Edit</button>
          <button type="button" aria-pressed={mobilePreview} onClick={() => { setMobilePreview(true); setSize("mobile"); }}><EditorIcon name="eyeIcon" />Preview</button>
        </div>
        <div className={styles.workspace} data-mobile-preview={mobilePreview}>
          <nav className={styles.sectionNav} aria-label="Editor sections">
            {sectionIds.map(id => <button key={id} type="button" aria-current={section === id ? "true" : undefined}
              aria-controls={`panel-${id}`} onClick={() => setSection(id)}>{sections[id]}</button>)}
          </nav>
          <div className={styles.editColumn}>
            <div className={styles.sectionPicker}>
              <label htmlFor="editor-section">Section</label>
              <select id="editor-section" value={section} onChange={e => setSection(e.target.value as Section)}>
                {sectionIds.map(id => <option key={id} value={id}>{sections[id]}</option>)}
              </select>
            </div>
            <form noValidate onSubmit={e => { e.preventDefault(); void coordinator.flush(); }}>
              <fieldset className={styles.editorFields} disabled={state.busyAction}>
                <legend className={styles.srOnly}>Private profile draft</legend>
                <div id="panel-identity" hidden={section !== "identity"} tabIndex={-1}><AboutFields {...fieldProps} /></div>
                <div id="panel-links" hidden={section !== "links"} tabIndex={-1}><LinkFields {...fieldProps} edit={linkEdit} onEdit={setLinkEdit} /></div>
                <div id="panel-embeds" hidden={section !== "embeds"} tabIndex={-1}><EmbedFields {...fieldProps} /></div>
                <div id="panel-appearance" hidden={section !== "appearance"} tabIndex={-1}><AppearanceFields {...fieldProps} preview={state.preview} /></div>
                <div id="panel-media" hidden={section !== "media"} tabIndex={-1}><MediaLibrary {...fieldProps} profileId={editorProfileId} disabled={state.busyAction} onMedia={setMedia} /></div>
                <div id="panel-discovery" hidden={section !== "discovery"} tabIndex={-1}><DiscoveryFields {...fieldProps} /></div>
              </fieldset>
            </form>
            <div id="panel-history" className={styles.history} hidden={section !== "history"} tabIndex={-1}>
              <section className={styles.section} aria-labelledby="publishing-title">
                <h2 id="publishing-title">Publishing</h2>
                <div className={styles.sectionHeading}>
                  <p className={styles.saveStatus} data-saved={published}>{published ? "Published" : "Unpublished"}</p>
                  {published && <a className={styles.shortcut} href={publicUrl} target="_blank" rel="noopener noreferrer">Open public page <EditorIcon name="externalIcon" /></a>}
                </div>
                <p className={styles.hint}>Saved edits go live when you publish them.</p>
                {published && <div className={styles.sectionFooter}>
                  <button type="button" disabled={blocked || !online} onClick={() => setConfirm("unpublish")}>Unpublish page</button>
                </div>}
              </section>
              <section className={styles.section} aria-labelledby="history-title">
                <h2 id="history-title">Publication history</h2>
                <p className={styles.hint}>Your five most recent publications are kept. Restoring one replaces the current draft and publishes that version.</p>
                {state.server.revisions.length ? <ol className={styles.revisions}>
                  {state.server.revisions.map(revision => <li key={revision.id}>
                    <div className={styles.linkSummary}>
                      <strong>Publication {revision.revisionNumber}</strong>
                      <time dateTime={revision.createdAt}>{new Date(revision.createdAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC</time>
                    </div>
                    {revision.id === state.server.publishedRevisionId && <span className={styles.liveLabel}>Live</span>}
                    <button type="button" disabled={blocked || !online} onClick={() => setConfirm({ restore: revision.id })} aria-label={`Restore publication ${revision.revisionNumber}`}>Restore</button>
                  </li>)}
                </ol> : <p className={styles.hint}>No publications yet.</p>}
              </section>
            </div>
          </div>
          <aside className={styles.previewColumn} aria-labelledby="preview-title">
            <div className={styles.previewHeading}>
              <h2 id="preview-title">Live preview</h2>
              <span className={styles.previewPhoneLabel}>Private</span>
              <div role="group" aria-label="Preview width" className={`${styles.segmented} ${styles.previewSizes}`}>
                <button type="button" aria-pressed={size === "mobile"} onClick={() => setSize("mobile")}><EditorIcon name="phoneIcon" />Mobile</button>
                <button type="button" aria-pressed={size === "desktop"} onClick={() => setSize("desktop")}><EditorIcon name="desktopIcon" />Desktop</button>
              </div>
            </div>
            {errorCount > 0 && <p className={styles.hint}>Showing the last valid draft.</p>}
            <LivePreview document={state.preview} username={state.server.username} siteDomain={siteDomain} media={media} size={size} />
            <div className={styles.previewFooter}>
              <a className={styles.shortcut} href="/preview" target="_blank" rel="noopener noreferrer">Open saved preview <EditorIcon name="externalIcon" /></a>
              <span>Private</span>
            </div>
          </aside>
        </div>
      </main>
    </div>
    <dialog ref={dialog} className={styles.dialog} onCancel={() => setConfirm(null)} onClose={() => setConfirm(null)} aria-labelledby="confirm-title">
      <h2 id="confirm-title">{confirm === "publish" ? "Publish this draft?" : confirm === "unpublish" ? "Take your page offline?" : confirm === "local" ? "Replace the compared server draft?" : confirm === "server" ? "Discard your local input?" : `Restore publication ${restoreRevision?.revisionNumber ?? ""}?`}</h2>
      {restoreRevision ? <p>Originally published {new Date(restoreRevision.createdAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC.</p> : null}
      <p>{confirm === "publish" ? "The editor will save all valid pending edits first, then publish that exact saved version. Your selected text, contact email, media and embeds will become public." : confirm === "unpublish" ? "Pending edits will save first. Your public page will be removed; draft and history remain available. Previously downloaded copies cannot be recalled." : confirm === "local" ? "Your complete local input will replace the compared server document on the next save. Server-only changes will be lost from the draft. Download both drafts or copy needed fields before continuing. A further server edit will cause another conflict." : confirm === "server" ? "Your unsaved local input will be discarded and replaced with the compared server draft. Download your local draft first if you need to keep it." : "Valid pending edits will save first. The chosen publication will replace the draft and become a new public publication. This can prune the oldest of five retained publications. Download your current draft if you want a separate copy."}</p>
      <div className={styles.inlineActions}><button type="button" onClick={() => setConfirm(null)}>Cancel</button><button type="button" onClick={downloadDraft}>Download local draft</button><button type="button" className={styles.primary} onClick={() => void confirmAction()}>Confirm</button></div>
    </dialog>
  </div>;
}
