import { randomUUID } from "node:crypto";
import type { Manifest } from "../../src/server/recovery/manifest";
export function manifest(): Manifest {
  return { version: 1, id: `snapshot-${Date.now()}-${randomUUID()}`, kind: "snapshot", createdAt: new Date().toISOString(), databaseVersion: 170011, recoverySequence: 0, eventCount: 0,
    files: [{ name: "file-0.enc", bytes: 0, sha256: "a".repeat(64) }],
    metadata: { roleNames: ["fixture"], siteDomain: "may-be.localhost", mediaStorage: "local", mediaPublicOrigin: "https://media.may-be.localhost", sourceMedia: "a".repeat(64), sourceDatabase: "b".repeat(64) } };
}
