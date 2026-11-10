export const MiB = 1024 ** 2;
export const IMAGE_BYTES = 5 * MiB;
export const AUDIO_BYTES = 10 * MiB;
export const DISPLAY_BYTES = MiB;
export const MAX_PIXELS = 16_000_000;
export const MAX_DURATION_MS = 180_000;
export const UPLOAD_TIMEOUT_MS = 60_000;
export const PARSER_TIMEOUT_MS = 20_000;
export const RESERVATION_MS = 15 * 60_000;
export { MAX_ASSETS, MAX_REJECTION_FEEDBACK } from "@/domain/media";
export function privateObjectSlots(kind: MediaKind) { return kind === "image" ? 2 : 1; }
export type MediaKind = "image" | "audio";
// Includes quarantine, validated copies from a retried parse, scratch input/output,
// derivatives, and a possible public copy. Reservations shrink after commit.
export function reservationBytes(kind: MediaKind) { return kind === "image" ? 24 * MiB : 50 * MiB; }
export function inputLimit(kind: MediaKind) { return kind === "image" ? IMAGE_BYTES : AUDIO_BYTES; }
