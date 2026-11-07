/** Display preferences only: never delete assets/cards or alter selected bodies. */
export interface PickerVisibility {
  hiddenPresetIds: string[];
  hiddenCardIds: string[];
}
export const defaultPickerVisibility = (): PickerVisibility => ({
  hiddenPresetIds: [],
  hiddenCardIds: [],
});
export function validPickerVisibility(
  value: unknown,
): value is PickerVisibility {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== 2 ||
    Object.keys(v).some(
      (k) => !["hiddenPresetIds", "hiddenCardIds"].includes(k),
    )
  )
    return false;
  return [
    [v.hiddenPresetIds, 256],
    [v.hiddenCardIds, 48],
  ].every(
    ([ids, limit]) =>
      Array.isArray(ids) &&
      ids.length <= Number(limit) &&
      new Set(ids).size === ids.length &&
      ids.every(
        (id) => typeof id === "string" && id.length > 0 && id.length <= 200,
      ),
  );
}
