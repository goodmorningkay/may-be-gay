export type PublicMedia = {
  url: string;
  contentType: string;
  width?: number;
  height?: number;
  durationMs?: number;
};
export type PublicMediaMap = Record<string, PublicMedia>;

// Reserve one slot per possible retained private object (two for an image,
// one for audio). The snapshot manifest also has one database file.
export const MAX_PRIVATE_MEDIA_OBJECTS = 9999;
export const MAX_ASSETS = 1000;
export const MAX_REJECTION_FEEDBACK = 20;
export const MAX_MEDIA_LIBRARY_ENTRIES = MAX_ASSETS + MAX_REJECTION_FEEDBACK;
