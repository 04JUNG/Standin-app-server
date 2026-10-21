/** Presentation approximation only. The stored precise camera is never changed. */
export const POSTER_VARIANT = "rough-yaw8-v1";
export type PosterOptions = { variant: typeof POSTER_VARIANT; view: string };
export type PosterCamera = {
  requestedYaw: number | null;
  selectedYaw: number;
  source: "fixed_117" | "semantic_preview" | "unavailable";
};

export function nearestYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) throw Error("invalid camera yaw");
  const normalized = ((yaw % 360) + 360) % 360;
  return (Math.floor((normalized + 22.5) / 45) % 8) * 45;
}

export function posterCamera(value: unknown): PosterCamera {
  const fallback: PosterCamera = {
    requestedYaw: null,
    selectedYaw: 0,
    source: "unavailable",
  };
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as {
    camera_kind?: string;
    render_camera?: Record<string, unknown>;
  };
  const c = candidate.render_camera;
  if (
    !c ||
    !["fixed_117", "semantic_preview"].includes(candidate.camera_kind ?? "") ||
    c.version !== "pose-preview-camera-v1" ||
    c.basis !== "right-handed-Y-up" ||
    c.rotation_order !== "Rz@Rx@Ry_column_vectors" ||
    c.bvh_camera_rotation_applied !== false ||
    ![c.yaw_degrees, c.pitch_degrees, c.roll_degrees].every(
      (v) => typeof v === "number" && Number.isFinite(v),
    )
  )
    return fallback;
  const [y, p, r] = [c.yaw_degrees, c.pitch_degrees, c.roll_degrees].map(
    (v) => ((v as number) * Math.PI) / 180,
  );
  const [cy, sy, cp, sp, cr, sr] = [
    Math.cos(y),
    Math.sin(y),
    Math.cos(p),
    Math.sin(p),
    Math.cos(r),
    Math.sin(r),
  ];
  const expected = [
    [cr * cy - sr * sp * sy, -sr * cp, cr * sy + sr * sp * cy],
    [sr * cy + cr * sp * sy, cr * cp, sr * sy - cr * sp * cy],
    [-cp * sy, sp, cp * cy],
  ];
  const matrix = c.rotation;
  if (
    !Array.isArray(matrix) ||
    matrix.length !== 3 ||
    expected.some(
      (row, i) =>
        !Array.isArray(matrix[i]) ||
        matrix[i].length !== 3 ||
        row.some(
          (x, j) =>
            typeof matrix[i][j] !== "number" ||
            !Number.isFinite(matrix[i][j]) ||
            Math.abs(x - matrix[i][j]) > 1e-5,
        ),
    )
  )
    return fallback;
  return {
    requestedYaw: c.yaw_degrees as number,
    selectedYaw: nearestYaw(c.yaw_degrees as number),
    source: candidate.camera_kind as PosterCamera["source"],
  };
}

export function posterOptions(camera: PosterCamera): PosterOptions {
  return {
    variant: POSTER_VARIANT,
    view: `yaw_${String(camera.selectedYaw).padStart(3, "0")}`,
  };
}

export function annotatePoster(
  response: Response,
  camera: PosterCamera,
): Response {
  response.headers.set("X-Standin-Poster-Camera-Source", camera.source);
  response.headers.set(
    "X-Standin-Poster-Requested-Yaw",
    camera.requestedYaw === null ? "none" : String(camera.requestedYaw),
  );
  if (camera.source === "unavailable")
    response.headers.set("X-Standin-Poster-Fallback", "camera_unavailable");
  return response;
}
