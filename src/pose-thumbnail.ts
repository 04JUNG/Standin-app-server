import { config } from "./config.js";

/** Version the browser cache when the library replaces images at stable IDs. */
export function poseThumbnailUrl(poseId: string, view: string): string {
  const path = `/v1/pose-candidates/${encodeURIComponent(poseId)}/thumbnail?view=${encodeURIComponent(view)}`;
  return config.poseThumbnailRevision
    ? `${path}&revision=${encodeURIComponent(config.poseThumbnailRevision)}`
    : path;
}
