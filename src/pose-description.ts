/** Quality-review data only. Stored with person tags, so consent withdrawal clears it too. */
export interface PoseDescription {
  status: string | null;
  reasons: string[];
  searchText: string | null;
  bodyDetails: string | null;
  certainty: string | null;
  visibleScope: string | null;
  postures: string[];
  actions: string[];
  objects: string[];
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
const text = (value: unknown, limit = 80): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
const words = (value: unknown): string[] => Array.isArray(value)
  ? value.slice(0, 20).map((item) => text(item)).filter((item): item is string => item !== null)
  : [];

/** Allowlist both incoming and stored data; never return the routing report or provider errors. */
export function parsePoseDescription(value: unknown): PoseDescription | null {
  const record = object(value);
  if (!record) return null;
  return {
    status: text(record.status),
    reasons: words(record.reasons),
    searchText: text(record.searchText, 4000),
    bodyDetails: text(record.bodyDetails, 4000),
    certainty: text(record.certainty),
    visibleScope: text(record.visibleScope),
    postures: words(record.postures),
    actions: words(record.actions),
    objects: words(record.objects),
  };
}

export function extractPoseDescription(person: {
  dynamic_search?: unknown;
  search_routing?: unknown;
}): PoseDescription | null {
  const routing = object(person.search_routing);
  const dynamic = object(person.dynamic_search) ?? object(routing?.fullbody_search);
  const evidence = object(dynamic?.description_evidence) ?? object(routing?.semantic_evidence);
  if (!evidence) return null;
  const description = object(evidence.description);
  return parsePoseDescription({
    status: evidence.status,
    reasons: evidence.reasons,
    searchText: description?.search_text,
    bodyDetails: description?.body_details,
    certainty: description?.certainty,
    visibleScope: description?.visible_scope,
    postures: description?.postures,
    actions: description?.actions,
    objects: description?.objects,
  });
}
