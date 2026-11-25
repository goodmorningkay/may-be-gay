"use client";
import { useEffect } from "react";
import { getSiteDomain, resolveHost, type SiteDomain } from "@/domain/hosts";
/** Parent mounts ONLY on a public profile. Add data-profile-link=<UUID> to native
 * public anchors, never redirect through metrics. No visitor identity or storage. */
export function PublicAnalytics({ username, domain = getSiteDomain() }: { username: string; domain?: SiteDomain }) {
  useEffect(() => {
    const host = resolveHost(location.host, domain);
    const privacy = navigator as Navigator & { globalPrivacyControl?: boolean };
    if (host.kind !== "profile" || host.username !== username || navigator.doNotTrack === "1" || privacy.globalPrivacyControl) return;
    let sent = false;
    const send = (event: { event: "view" } | { event: "click"; linkId: string }) => {
      void fetch("/api/metrics", { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify(event), keepalive: true, referrerPolicy: "no-referrer" }).catch(() => {});
    };
    const view = () => { if (!sent && document.visibilityState === "visible") { sent = true; send({ event: "view" }); } };
    const click = (e: MouseEvent) => {
      if (!e.isTrusted || (e.type === "auxclick" && e.button !== 1)) return;
      const target = e.target instanceof Element ? e.target.closest<HTMLElement>("a[data-profile-link], button[data-profile-link]") : null;
      const linkId = target?.dataset.profileLink;
      if (linkId && /^[0-9a-f-]{36}$/i.test(linkId)) send({ event: "click", linkId });
    };
    // Effects don't execute on server render/RSC prefetch; wait for real visible
    // navigation and do not interfere with native anchor behavior.
    const frame = requestAnimationFrame(view);
    document.addEventListener("visibilitychange", view);
    document.addEventListener("click", click); document.addEventListener("auxclick", click);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("visibilitychange", view); document.removeEventListener("click", click); document.removeEventListener("auxclick", click); };
  }, [username, domain]);
  return null;
}
