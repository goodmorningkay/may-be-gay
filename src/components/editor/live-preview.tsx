"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProfileDocument } from "@/domain/profile";
import type { PublicMediaMap } from "@/domain/media";
import { ProfileView } from "@/components/profile-view";
import { EditorIcon } from "./editor-icon";
import styles from "./editor.module.css";

/** Same-origin empty frame gives ProfileView a real responsive viewport, without an API read or publication. */
export function LivePreview({ document: profile, username, siteDomain, media, size }: { document: ProfileDocument; username: string; siteDomain: string; media: PublicMediaMap; size: "mobile" | "desktop" }) {
  const width = size === "mobile" ? 375 : 960;
  const viewport = useRef<HTMLDivElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const box = viewport.current;
    const frame = iframe.current;
    if (!box || !frame) return;
    const fit = () => {
      const { clientWidth, clientHeight } = box;
      if (!clientWidth || !clientHeight) return;
      // Fit the frame without changing the renderer's viewport width.
      const scale = Math.min(1, clientWidth / width);
      frame.style.height = `${Math.ceil(clientHeight / scale)}px`;
      frame.style.transform = `scale(${scale})`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [width]);
  useEffect(() => {
    if (!target) return;
    const previewDocument = target.ownerDocument;
    function copyStyles() {
      previewDocument.head.querySelectorAll("[data-editor-style]").forEach(node => node.remove());
      window.document.querySelectorAll('link[rel="stylesheet"], style').forEach(node => {
        const copy = node.cloneNode(true) as HTMLElement;
        copy.setAttribute("data-editor-style", ""); previewDocument.head.appendChild(copy);
      });
    }
    copyStyles();
    const observer = new MutationObserver(copyStyles);
    observer.observe(window.document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [target]);
  const background = profile.backgroundAssetId ? media[profile.backgroundAssetId.toLowerCase()] : undefined;
  return <div className={styles.previewStage} data-size={size}>
    {background && <div className={styles.previewBackdrop} aria-hidden="true" style={{ backgroundImage: `url("${background.url}")` }} />}
    <div className={styles.previewWindow}>
      <div className={styles.browserAddress} aria-hidden="true"><EditorIcon name="browserControls" />{username}.{siteDomain}</div>
      <div className={styles.previewViewport} ref={viewport}>
        <iframe ref={iframe} className={styles.previewFrame} width={width} title={`Private local profile preview at ${width} pixels`}
          srcDoc={'<!doctype html><html lang="en"><head><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Private local preview</title></head><body></body></html>'}
          onLoad={event => {
            const body = event.currentTarget.contentDocument?.body;
            if (body) setTarget(body);
          }} />
      </div>
    </div>
    {target ? createPortal(<div onClickCapture={event => {
      const anchor = (event.target as HTMLElement).closest("a");
      if (anchor) { anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; }
    }}><ProfileView document={profile} username={username} siteDomain={siteDomain} media={media} livePreview /></div>, target) : null}
  </div>;
}
