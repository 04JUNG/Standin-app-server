import { config } from "./config.js";

/** Version the browser cache when the library replaces images at stable IDs. */
export function poseThumbnailUrl(poseId: string, view: string): string {
  const path = `/v1/pose-candidates/${encodeURIComponent(poseId)}/thumbnail?view=${encodeURIComponent(view)}`;
  return config.poseThumbnailRevision
    ? `${path}&revision=${encodeURIComponent(config.poseThumbnailRevision)}`
    : path;
}

/** Distinct representation URL bypasses cached legacy JPEGs even without env revision. */
export function humanThumbnailUrl(poseId: string): string {
  const params = new URLSearchParams({ revision: "human-poster-v1" });
  if (config.poseThumbnailRevision) params.set("assetRevision", config.poseThumbnailRevision);
  return `/v1/pose-candidates/${encodeURIComponent(poseId)}/reference-thumbnail?${params}`;
}
