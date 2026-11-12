/** Accept only the final artifact's camera; never infer optics in the BFF. */
import { z } from "zod";
import { ConverterError } from "../converter/client.js";

const finite = z.number().finite();
const coordinate = finite.min(-100000).max(100000);
const vector = z.tuple([coordinate, coordinate, coordinate]);
export const cameraRecipeSchema = z.object({
  version: z.literal("scene-camera-v1"),
  source_dimensions: z.tuple([z.number().int().min(16).max(50000), z.number().int().min(16).max(50000)]),
  projection: z.literal("perspective"),
  horizontal_fov_degrees: finite.gt(0).lt(160),
  vertical_fov_degrees: finite.gt(0).lt(180),
  principal_pixels: z.tuple([finite.nonnegative(), finite.nonnegative()]),
  csp: z.object({
    coordinate_system: z.literal("y-up-centimeters"),
    camera_position: vector, focal_point_position: vector,
    roll_degrees: z.literal(0),
    perspective: finite.positive().max(100000), perspective_ui_value: finite.nonnegative().max(100000),
    link_camera_advancing_retreating: z.literal(false), adapt_view_to_object: z.literal(false),
  }),
  requires_camera_application: z.literal(true),
  automatic_import_framing_verified: z.literal(false),
  csp_recipe_application_verified: z.literal(false),
  preconditions: z.array(z.string().max(128)).max(8),
  formula_source: z.literal("https://www.clip-studio.com/clip_site/support/help/detail/svc/53/tid/88435"),
});
const bindingSchema = z.object({
  version: z.literal("scene-camera-artifact-v1"),
  artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/), recipe: cameraRecipeSchema,
});
export type SceneCameraBinding = z.infer<typeof bindingSchema>;
export function validateSceneCamera(value: unknown, artifactSha: string,
  image?: { width: number; height: number }): SceneCameraBinding {
  const parsed = bindingSchema.safeParse(value);
  if (!parsed.success) throw new ConverterError("CONVERTER_INTEGRITY", "invalid scene camera");
  const binding = parsed.data, r = binding.recipe;
  const [w, h] = r.source_dimensions;
  const tangent = Math.tan(r.horizontal_fov_degrees * Math.PI / 360) * h / w;
  const expectedVertical = Math.atan(tangent) * 360 / Math.PI;
  const expectedPerspective = 100 * tangent / Math.tan(80 * Math.PI / 180);
  const [x, y, z] = r.csp.camera_position;
  if (binding.artifact_sha256 !== artifactSha ||
      (image && (w !== image.width || h !== image.height)) ||
      r.principal_pixels[0] !== w / 2 || r.principal_pixels[1] !== h / 2 ||
      Math.abs(r.vertical_fov_degrees - expectedVertical) > 1e-5 ||
      Math.abs(r.csp.perspective - expectedPerspective) > 1e-5 ||
      Math.abs(r.csp.perspective_ui_value - expectedPerspective) > 0.005001 ||
      r.csp.focal_point_position.some((v, i) => Math.abs(v - [x, y, z - 100][i]) > 1e-5))
    throw new ConverterError("CONVERTER_INTEGRITY", "scene camera lineage mismatch");
  return binding;
}
export function readSceneCameraHeader(header: string | null, sha: string,
  image: { width: number; height: number }): SceneCameraBinding | undefined {
  if (header === null) return undefined; // Old converter: retain explicit unavailable state.
  try {
    if (header.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(header)) throw new Error();
    const decoded = Buffer.from(header, "base64");
    if (decoded.toString("base64") !== header) throw new Error();
    return validateSceneCamera(JSON.parse(decoded.toString("utf8")), sha, image);
  } catch {
    throw new ConverterError("CONVERTER_INTEGRITY", "scene camera header mismatch");
  }
}
