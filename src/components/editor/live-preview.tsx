"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { ProfileDocument } from "@/domain/profile";
import type { PublicMediaMap } from "@/domain/media";
import { ProfileView } from "@/components/profile-view";
import styles from "./editor.module.css";

/** Same-origin empty frame gives ProfileView a real responsive viewport, without an API read or publication. */
export function LivePreview({ document: profile, username, siteDomain, media, size }: { document: ProfileDocument; username: string; siteDomain: string; media: PublicMediaMap; size: "mobile" | "desktop" }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
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
  return <div className={styles.previewViewport} tabIndex={0} role="region" aria-label={`${size} preview; scroll horizontally for the full width`}>
    <iframe className={styles.previewFrame} data-size={size} title={`Private local profile preview at ${size === "mobile" ? "375" : "960"} pixels`}
      srcDoc={'<!doctype html><html lang="en"><head><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Private local preview</title></head><body></body></html>'}
      onLoad={event => {
        const body = event.currentTarget.contentDocument?.body;
        if (body) setTarget(body);
      }} />
    {target ? createPortal(<div onClickCapture={event => {
      const anchor = (event.target as HTMLElement).closest("a");
      if (anchor) { anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; }
    }}><ProfileView document={profile} username={username} siteDomain={siteDomain} media={media} /></div>, target) : null}
  </div>;
}
