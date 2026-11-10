/* eslint-disable @next/next/no-html-link-for-pages -- Full document navigation lets beforeunload protect private unsaved input. */
"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { EditorCoordinator, changedFields, type EditorAction, type EditorState } from "@/domain/editor";
import type { PublicMediaMap } from "@/domain/media";
import { editorTransport } from "./api";
import { AppearanceFields } from "./appearance-fields";
import { ContentFields, DiscoveryFields } from "./content-fields";
import { MediaLibrary } from "./media-library";
import { LivePreview } from "./live-preview";
import styles from "./editor.module.css";

export function ProfileEditor({ initial, siteDomain }: { initial: EditorState; siteDomain: string }) {
  const [coordinator] = useState(() => new EditorCoordinator(initial, editorTransport));
  const [editorProfileId] = useState(initial.profileId);
  const state = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot);
  const [media, setMedia] = useState<PublicMediaMap>({});
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
  const status = state.conflict ? "Conflict · your input is retained" : !online ? "Offline · input retained in this tab" : state.busyAction ? "Applying publication change…" : state.saving ? "Saving draft…" : state.problem ? "Save or action needs attention" : errorCount ? "Not saved · check the fields below" : state.dirty ? "Unsaved changes" : `Draft saved · version ${state.server.editVersion}`;
  const publicUrl = `https://${state.server.username}.${siteDomain}`;
  const restoreRevision = confirm && typeof confirm === "object" ? state.server.revisions.find(revision => revision.id === confirm.restore) : null;
  return <div className={styles.editor}>
    <header className={styles.header}><a className={styles.wordmark} href="/">may-be.gay</a>
      <nav aria-label="Your account"><a href="/account/security">Security</a><a href="/account">Account</a><a href="/account/analytics">Analytics</a></nav></header>
    <main>
      <div className={styles.titleRow}><div><p className={styles.eyebrow}>Your private workspace</p><h1>A little space, all yours.</h1>
        <p className={styles.address}>{state.server.username}.{siteDomain} <span>· Username fixed during beta</span></p></div>
        <div className={styles.publicationBadge}>{state.server.publishedRevisionId ? "Published page live" : "Unpublished · only you can preview"}</div></div>
      <div className={styles.saveBar}><div><p role="status" aria-live="polite" aria-atomic="true" className={styles.saveStatus}>{status}</p><span className={styles.hint}>Edits autosave privately. Publish when you want them on your public page.</span></div>
        <div className={styles.inlineActions}><button type="button" disabled={blocked || state.saving || !online || !state.dirty} onClick={() => void coordinator.flush()}>Save now</button>
          <button type="button" className={styles.primary} disabled={blocked || !online} onClick={() => setConfirm("publish")}>{state.server.publishedRevisionId ? "Publish changes" : "Publish page"}</button></div></div>
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
      {errorCount ? <div className={styles.errorBox}><strong>{errorCount} {errorCount === 1 ? "field needs" : "fields need"} attention before saving or publishing.</strong>
        <ul>{Object.entries(state.errors).map(([field, message]) => <li key={field}><a href={`#field-${field}`}>{field}: {message}</a></li>)}</ul></div> : null}
      <nav className={styles.sectionNav} aria-label="Editor sections"><a href="#identity">About you</a><a href="#links">Links</a><a href="#appearance">Appearance</a><a href="#media">Media</a><a href="#discovery">Discovery</a><a href="#history">Publishing</a><a href="#live-preview">Preview</a></nav>
      <div className={styles.workspace}><div className={styles.editColumn}>
        <form noValidate onSubmit={e => { e.preventDefault(); void coordinator.flush(); }}><fieldset className={styles.editorFields} disabled={state.busyAction}>
          <legend className={styles.srOnly}>Private profile draft</legend>
          <ContentFields document={state.local} errors={state.errors} onChange={setDocument} />
          <AppearanceFields document={state.local} preview={state.preview} errors={state.errors} onChange={setDocument} />
          <MediaLibrary profileId={editorProfileId} document={state.local} errors={state.errors} disabled={state.busyAction} onChange={setDocument} onMedia={setMedia} />
          <DiscoveryFields document={state.local} errors={state.errors} onChange={setDocument} />
        </fieldset></form>
        <section id="history" className={styles.section} aria-labelledby="history-title"><h2 id="history-title">Publishing & history</h2>
          <p>{state.server.publishedRevisionId ? "Your published page uses its last published revision. Saved draft changes appear there only after you publish." : "Your page is unpublished. Your saved draft and retained publications are private."}</p>
          <div className={styles.inlineActions}><a href="/preview" target="_blank" rel="noopener noreferrer">Open saved private preview ↗</a>
            {state.server.publishedRevisionId ? <a href={publicUrl} target="_blank" rel="noopener noreferrer">Open public page ↗</a> : null}
            <button type="button" disabled={blocked || !online || !state.server.publishedRevisionId} onClick={() => setConfirm("unpublish")}>Unpublish page</button></div>
          <p className={styles.hint}>The separate private preview reads the saved draft. The preview alongside this editor shows your last valid local input. Neither preview publishes.</p>
          <h3>Retained publications</h3><p className={styles.hint}>Up to five, newest first. Restoration saves your valid pending edits, then replaces the draft and creates a new publication. Media used by this history continues to count toward storage.</p>
          <ol className={styles.revisions}>{state.server.revisions.map(revision => <li key={revision.id}><div><strong>Publication {revision.revisionNumber}{revision.id === state.server.publishedRevisionId ? " · Live" : ""}</strong>
            <p><time dateTime={revision.createdAt}>{new Date(revision.createdAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC</time></p></div>
            <button type="button" disabled={blocked || !online} onClick={() => setConfirm({ restore: revision.id })} aria-label={`Restore publication ${revision.revisionNumber}`}>Restore</button></li>)}</ol>
          {!state.server.revisions.length ? <p>No publications yet. Your first publication will appear here.</p> : null}
        </section>
      </div>
      <aside id="live-preview" className={styles.previewColumn} aria-labelledby="preview-title"><div className={styles.previewHeading}><div><h2 id="preview-title">Private live preview</h2><p className={styles.hint}>{errorCount ? "Showing the last valid input while you correct the fields." : "Current local draft · visible only to you here"}</p></div>
        <div role="group" aria-label="Preview width" className={styles.inlineActions}><button type="button" aria-pressed={size === "mobile"} onClick={() => setSize("mobile")}>Mobile</button><button type="button" aria-pressed={size === "desktop"} onClick={() => setSize("desktop")}>Desktop</button></div></div>
        <p className={styles.hint}>Preview links open in new tabs. Music plays only when you choose Play.</p>
        <LivePreview document={state.preview} username={state.server.username} siteDomain={siteDomain} media={media} size={size} />
      </aside></div>
      <p className={styles.bottomNote}>Private input stays in this tab until saved. Browser navigation warns about pending changes where supported. Download a local copy before closing if saving is unavailable.</p>
    </main>
    <dialog ref={dialog} className={styles.dialog} onCancel={() => setConfirm(null)} onClose={() => setConfirm(null)} aria-labelledby="confirm-title">
      <h2 id="confirm-title">{confirm === "publish" ? "Publish this draft?" : confirm === "unpublish" ? "Take your page offline?" : confirm === "local" ? "Replace the compared server draft?" : confirm === "server" ? "Discard your local input?" : `Restore publication ${restoreRevision?.revisionNumber ?? ""}?`}</h2>
      {restoreRevision ? <p>Originally published {new Date(restoreRevision.createdAt).toLocaleString("en-GB", { timeZone: "UTC" })} UTC.</p> : null}
      <p>{confirm === "publish" ? "The editor will save all valid pending edits first, then publish that exact saved version. Your selected text, contact email and media will become public." : confirm === "unpublish" ? "Pending edits will save first. Your public page will be removed; draft and history remain available. Previously downloaded copies cannot be recalled." : confirm === "local" ? "Your complete local input will replace the compared server document on the next save. Server-only changes will be lost from the draft. Download both drafts or copy needed fields before continuing. A further server edit will cause another conflict." : confirm === "server" ? "Your unsaved local input will be discarded and replaced with the compared server draft. Download your local draft first if you need to keep it." : "Valid pending edits will save first. The chosen publication will replace the draft and become a new public publication. This can prune the oldest of five retained publications. Download your current draft if you want a separate copy."}</p>
      <div className={styles.inlineActions}><button type="button" onClick={() => setConfirm(null)}>Cancel</button><button type="button" onClick={downloadDraft}>Download local draft</button><button type="button" className={styles.primary} onClick={() => void confirmAction()}>Confirm</button></div>
    </dialog>
  </div>;
}
