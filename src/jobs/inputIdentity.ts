/** Persist only a basename; names never enter logs or server filesystem paths. */
export function safeOriginalName(value: string): string | null {
  const name = value.replace(/\\/g, "/").split("/").pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name && !["blob", ".", ".."].includes(name) ? name.slice(0, 255) : null;
}
