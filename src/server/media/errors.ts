import { AppError } from "@/server/http";
export class MediaError extends AppError {}
export function invalidMedia() { return new MediaError(422, "MEDIA_INVALID", "Upload a GIF, static JPEG, PNG or WebP image, or an MP3 within the media limits."); }
export function providerUnavailable() { return new MediaError(503, "MEDIA_PROVIDER_UNCONFIGURED", "Media storage is not configured."); }
export function storageFailure() { return new MediaError(503, "MEDIA_STORAGE_UNAVAILABLE", "Media storage is temporarily unavailable."); }
export function capacity(code = "MEDIA_QUOTA_EXCEEDED") { return new MediaError(507, code, "Media storage capacity is unavailable. Remove unused assets or try again later."); }
