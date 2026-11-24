import "server-only";
import { providerUnavailable, storageFailure } from "./errors";
import type { MediaStorageAdapter } from "./storage";
export interface MediaPurgeAdapter { purge(urls: string[]): Promise<void> }
export class LocalMediaPurge implements MediaPurgeAdapter { async purge(_urls: string[]) { void _urls; /* Local reads check live DB references and use no-store. */ } }
export class CloudflareMediaPurge implements MediaPurgeAdapter {
  constructor(readonly zoneId: string, readonly token: string, readonly origin: string) {
    if (!/^[a-f0-9]{32}$/.test(zoneId) || !token || new URL(origin).origin !== origin) throw providerUnavailable();
  }
  async purge(urls: string[]) {
    if (urls.some(url => !url.startsWith(`${this.origin}/media/v1/`)) || urls.length > 30) throw storageFailure();
    if (!urls.length) return;
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${this.zoneId}/purge_cache`, {
        method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({ files: urls }), signal: AbortSignal.timeout(10_000), redirect: "error",
      });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader(); let body = "", bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.length; if (bytes > 16384) throw new Error();
          body += Buffer.from(value).toString("utf8");
        }
      } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (JSON.parse(body).success !== true) throw new Error();
    } catch { throw storageFailure(); }
  }
}
export function getMediaPurge(storage: MediaStorageAdapter): MediaPurgeAdapter {
  if (storage.kind === "local") return new LocalMediaPurge();
  if (!process.env.MEDIA_CLOUDFLARE_ZONE_ID || !process.env.MEDIA_CLOUDFLARE_PURGE_TOKEN || !process.env.MEDIA_PUBLIC_ORIGIN) throw providerUnavailable();
  return new CloudflareMediaPurge(process.env.MEDIA_CLOUDFLARE_ZONE_ID, process.env.MEDIA_CLOUDFLARE_PURGE_TOKEN, process.env.MEDIA_PUBLIC_ORIGIN);
}
