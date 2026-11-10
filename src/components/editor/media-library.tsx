/* eslint-disable @next/next/no-img-element -- Only validated, authenticated same-origin media is displayed. */
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProfileDocument } from "@/domain/profile";
import type { PublicMediaMap } from "@/domain/media";
import { EditorRequestError, type FieldErrors } from "@/domain/editor";
import { checked, mediaListSchema, requestJson, type MediaList } from "./api";
import { Field } from "./fields";
import styles from "./editor.module.css";

const MiB = 1024 ** 2;
function bytes(value: number) { return `${(value / MiB).toFixed(1)} MiB`; }
function assetName(asset: MediaList["assets"][number]) { return `${asset.kind === "image" ? "Image" : "MP3"} ${asset.id.slice(0, 8)}${asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ""}${asset.durationMs ? ` · ${Math.ceil(asset.durationMs / 1000)}s` : ""}`; }
export function MediaLibrary({ profileId, document: d, errors, disabled, onChange, onMedia }: {
  profileId: string; document: ProfileDocument; errors: FieldErrors; disabled: boolean; onChange: (document: ProfileDocument) => void; onMedia: (map: PublicMediaMap) => void;
}) {
  const [list, setList] = useState<MediaList | null>(null);
  const [problem, setProblem] = useState<EditorRequestError | null>(null);
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const lifecycle = useRef<{ alive: boolean; serial: number; timer?: ReturnType<typeof setTimeout>; request?: AbortController; mutation?: AbortController }>({ alive: false, serial: 0 });
  const refresh = useCallback(async function refreshMedia(remaining = 20) {
    const life = lifecycle.current;
    clearTimeout(life.timer); life.request?.abort();
    const serial = ++life.serial, controller = new AbortController(); life.request = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    setRefreshing(true);
    try {
      const next = checked(mediaListSchema, await requestJson("/api/media", { headers: { "x-editor-profile": profileId }, signal: controller.signal }));
      if (!life.alive || serial !== life.serial) return;
      setList(next); setProblem(null);
      const map: PublicMediaMap = {};
      for (const asset of next.assets) if (asset.state === "ready" && asset.contentType) {
        map[asset.id.toLowerCase()] = { url: `/api/media/${asset.id}/content`, contentType: asset.contentType,
          ...(asset.width ? { width: asset.width } : {}), ...(asset.height ? { height: asset.height } : {}), ...(asset.durationMs ? { durationMs: asset.durationMs } : {}) };
      }
      onMedia(map);
      if (next.assets.some(asset => ["quarantined", "processing"].includes(asset.state))) {
        if (remaining > 0) life.timer = setTimeout(() => { void refreshMedia(remaining - 1); }, 3000);
        else setNotice("Processing is taking longer than a minute. Automatic checks have stopped. Refresh when you are ready; queued media needs the processing worker.");
      }
    } catch (error) {
      if (!life.alive || serial !== life.serial) return;
      if (timedOut) { setProblem(new EditorRequestError(408, "MEDIA_REFRESH_TIMEOUT", "The media refresh timed out. Automatic checks have stopped; refresh to try again.")); return; }
      if (controller.signal.aborted) return;
      setProblem(error instanceof EditorRequestError ? error : new EditorRequestError(500, "REQUEST_FAILED", "Could not refresh your media."));
    } finally { clearTimeout(timeout); if (life.alive && serial === life.serial) setRefreshing(false); }
  }, [onMedia, profileId]);
  useEffect(() => {
    const life = lifecycle.current; life.alive = true;
    void refresh();
    return () => { life.alive = false; life.serial++; clearTimeout(life.timer); life.request?.abort(); life.mutation?.abort(); };
  }, [refresh]);
  async function upload(file: File | undefined, kind: "image" | "audio") {
    if (!file) return;
    const limit = (kind === "image" ? 5 : 10) * MiB;
    if (!file.size || file.size > limit) { setProblem(new EditorRequestError(413, "FILE_LIMIT", `Choose a nonempty ${kind} file up to ${bytes(limit)}.`)); return; }
    const life = lifecycle.current, controller = new AbortController(); life.mutation = controller;
    setWorking(true); setProblem(null); setNotice("Uploading privately…");
    try {
      await requestJson(`/api/media?kind=${kind}`, { method: "POST", body: file, headers: { "content-type": "application/octet-stream", "x-editor-profile": profileId }, signal: controller.signal });
      if (!life.alive) return;
      setNotice("Upload accepted for validation. Select it only after it becomes ready.");
      await refresh();
    } catch (error) {
      if (life.alive && !controller.signal.aborted) { setProblem(error as EditorRequestError); setNotice("Upload was not confirmed. Refresh the library before uploading again."); }
    } finally { if (life.alive) setWorking(false); }
  }
  async function remove(id: string) {
    if ([d.avatarAssetId, d.backgroundAssetId, d.music?.assetId].some(selected => selected?.toLowerCase() === id.toLowerCase())) {
      setProblem(new EditorRequestError(409, "MEDIA_SELECTED", "This asset is selected in your local draft. Remove that selection and save before deleting. Retained publications can still prevent deletion.")); return;
    }
    if (!window.confirm("Delete this asset? The server will refuse if the saved draft or any retained publication still uses it.")) return;
    const life = lifecycle.current, controller = new AbortController(); life.mutation = controller;
    setWorking(true); setProblem(null);
    try {
      await requestJson(`/api/media/${id}`, { method: "DELETE", headers: { "x-editor-profile": profileId }, signal: controller.signal });
      if (!life.alive) return;
      setNotice("Deletion queued. Storage charges may remain until file cleanup finishes."); await refresh();
    } catch (error) { if (life.alive && !controller.signal.aborted) setProblem(error as EditorRequestError); }
    finally { if (life.alive) setWorking(false); }
  }
  const unavailable = disabled || working || !list || list.quota.uploadsPaused || !list.quota.globalCapacityAvailable || list.usage.chargedBytes >= list.quota.limitBytes;
  function selector(name: string, label: string, kind: "image" | "audio", value: string | null | undefined, change: (id: string | null) => void) {
    const choices = list?.assets.filter(asset => asset.kind === kind && asset.state === "ready") ?? [];
    const selected = value?.toLowerCase();
    return <Field name={name} label={label} errors={errors}>{props => <select {...props} disabled={disabled} value={selected ?? ""} onChange={e => change(e.target.value || null)}>
      <option value="">None</option>{selected && !choices.some(asset => asset.id === selected) ? <option value={selected} disabled>Selected asset · unavailable / checking</option> : null}
      {choices.map(asset => <option key={asset.id} value={asset.id}>{assetName(asset)}</option>)}</select>}</Field>;
  }
  return <section id="media" className={styles.section} aria-labelledby="media-title"><div className={styles.sectionHeading}><h2 id="media-title">Images & music</h2><button type="button" disabled={refreshing || working} onClick={() => { setNotice(""); void refresh(); }}>Refresh media</button></div>
    <p className={styles.sectionIntro}>Uploads stay private until publication. Choose from your validated assets; external media URLs are not accepted.</p>
    <div className={styles.feedback}>{list ? <>
      <strong>{bytes(list.usage.chargedBytes)} charged / {bytes(list.quota.limitBytes)} quota</strong>
      <progress aria-label="Media storage used" max={Math.max(1, list.quota.limitBytes)} value={Math.min(list.usage.chargedBytes, list.quota.limitBytes)} />
      <p className={styles.hint}>{bytes(list.usage.privateBytes)} private files · {bytes(list.usage.publicReservedBytes)} public-copy reservation. Charges include upload reservations, derivatives and retained draft/history assets. Image uploads reserve 24 MiB; MP3 uploads reserve 50 MiB until processing settles.</p>
      {list.quota.uploadsPaused ? <p>Uploads are paused by the service. Existing ready assets can still be selected.</p> : null}
      {!list.quota.globalCapacityAvailable ? <p>Service storage capacity is currently full. Try refreshing later.</p> : null}
    </> : <p>{refreshing ? "Loading your storage usage…" : "Storage usage is unavailable. Refresh before uploading."}</p>}</div>
    <div className={styles.twoColumns}><label className={styles.field}>Upload image<input type="file" accept="image/jpeg,image/png,image/webp" disabled={unavailable} onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; void upload(file, "image"); }} /><span className={styles.hint}>Static JPEG, PNG or WebP · up to 5 MiB / 16 megapixels. Metadata is removed during validation.</span></label>
      <label className={styles.field}>Upload music<input type="file" accept="audio/mpeg,.mp3" disabled={unavailable} onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; void upload(file, "audio"); }} /><span className={styles.hint}>MP3 only · up to 10 MiB / 3 minutes. Upload only music you have permission to share.</span></label></div>
    <p role="status" className={styles.hint}>{notice}</p>
    {problem ? <div className={styles.errorBox} role="status"><p>{problem.message} <small>({problem.code})</small></p>
      {problem.code === "MEDIA_RETAINED" ? <p>Remove references from the draft and save. Assets used by any of the five retained publications remain protected until those publications leave history. No reference was removed.</p> : null}
      {problem.status === 401 ? <a target="_blank" rel="noopener noreferrer" href="/sign-in?returnTo=%2Feditor">Sign in in a new tab, then refresh</a> : null}</div> : null}
    {selector("avatarAssetId", "Avatar", "image", d.avatarAssetId, id => onChange({ ...d, avatarAssetId: id }))}
    {selector("backgroundAssetId", "Background image", "image", d.backgroundAssetId, id => onChange({ ...d, backgroundAssetId: id }))}
    {selector("music.assetId", "Profile music", "audio", d.music?.assetId, id => onChange({ ...d, music: id ? { assetId: id, attribution: d.music?.attribution ?? "" } : null }))}
    {d.music ? <Field name="music.attribution" label="Music rights / attribution" hint="Required. Name the track, artist and your permission or licence. Visitors start playback themselves." errors={errors}>{props => <textarea {...props} disabled={disabled} rows={3} maxLength={300} value={d.music?.attribution ?? ""} onChange={e => { if (d.music) onChange({ ...d, music: { ...d.music, attribution: e.target.value } }); }} />}</Field> : null}
    <details className={styles.assetDetails}><summary>Asset library{list ? ` (${list.assets.length})` : ""}</summary>
      <ul className={styles.assetList}>{list?.assets.map(asset => <li key={asset.id}>
        {asset.kind === "image" && asset.state === "ready" ? <img src={`/api/media/${asset.id}/content`} width={56} height={56} alt="" loading="lazy" /> : null}
        <div><strong>{assetName(asset)}</strong><p className={styles.hint}>{asset.state}{asset.bytes ? ` · ${bytes(asset.bytes)}` : ""}{asset.state === "rejected" ? " · Validation failed. Files are cleaned up automatically; the latest 20 failures are kept for feedback. Choose a new file within the limits." : ""}{["quarantined", "processing"].includes(asset.state) ? " · Waiting for private validation" : ""}</p></div>
        {asset.state !== "rejected" ? <button type="button" disabled={disabled || working} aria-label={`Delete ${assetName(asset)}`} onClick={() => void remove(asset.id)}>Delete</button> : null}
      </li>)}</ul>{list?.assets.length === 0 ? <p>Your library is empty.</p> : null}
    </details>
  </section>;
}
