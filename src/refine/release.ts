/** Durable, owner-scoped RC4 delivery. No legacy BVH row or output is overwritten. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { releaseRefine, releaseFbx, releasePreview } from "../inference.js";
import { loadInput } from "../inputStorage.js";
import { getRefinedBvh, putRefinedBvh, refinedStorageAvailable } from "../refineStorage.js";
import { getOwnedJob } from "../jobs/store.js";
import { loadCandidate } from "./store.js";
const v3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const releaseCamera = z.object({
  camera: z.tuple([v3,v3,v3]), origin:v3, anchor_camera_xyz:v3,
  projection:z.enum(["orthographic","perspective"]), inverse_distance:z.number().finite().nonnegative(),
  pixel_scale:z.number().finite().positive(), offset:z.tuple([z.number().finite(),z.number().finite()]),
  image_size:z.tuple([z.number().positive().int(),z.number().positive().int()]), embedded_in_fbx:z.literal(false),
});
const sourceReceipt = z.object({identity:z.object({version:z.literal("original-bvh-assets-v1"),bvh_sha256:z.string().regex(/^[a-f0-9]{64}$/),body_sha256:z.string().regex(/^[a-f0-9]{64}$/),builder_sha256:z.string().regex(/^[a-f0-9]{64}$/),blender_version:z.string()}),cache_key:z.string().regex(/^[a-f0-9]{64}$/),cache_hit:z.boolean(),pose_id:z.string(),zero_manual_edits:z.literal(true)});
const accepted = z.object({source:sourceReceipt.optional(),version:z.literal("New Refine Release RC4"),status:z.literal("accepted"),handle:z.string().regex(/^[a-f0-9]{32}$/),preview_sha256:z.string().regex(/^[a-f0-9]{64}$/),artifact_sha256:z.string().regex(/^[a-f0-9]{64}$/),camera:releaseCamera,selected:z.string()});
const held = z.object({version:z.literal("New Refine Release RC4"),status:z.literal("withheld"),download_url:z.null(),reason_codes:z.array(z.string())});
type Location = {installationId:string;jobId:string;personIndex:number;candidateId:string};
function key(p:Location) {
  const candidate = createHash("sha256").update(p.candidateId).digest("hex");
  if (![p.installationId,p.jobId].every(s=>/^[a-zA-Z0-9_-]+$/.test(s)) || !Number.isInteger(p.personIndex) || p.personIndex<0) throw new Error("invalid owner");
  return `installations/${p.installationId}/jobs/${p.jobId}/release-rc4/${p.personIndex}/${candidate}`;
}
export function releaseEnabled(){return process.env.REFINE_RELEASE_ENABLED === "1";}
const digest=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
export async function readRelease(p:Location) {
  const bytes=await getRefinedBvh(key(p)+".json");
  if(!bytes)return null;
  return accepted.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
}
export async function downloadRelease(p:Location) {
  const record=await readRelease(p);if(!record)return null;
  const bytes=await getRefinedBvh(key(p)+".fbx");
  if(!bytes || digest(bytes)!==record.artifact_sha256)return null;
  return {record,bytes};
}
export async function downloadReleasePreview(p:Location) {
  const record=await readRelease(p);if(!record)return null;
  const bytes=await getRefinedBvh(key(p)+".glb");
  if(!bytes || digest(bytes)!==record.preview_sha256)return null;
  return {record,bytes};
}
const inFlight=new Map<string,Promise<unknown>>();
export async function runRelease(p:Location) {
  if(!releaseEnabled() || !refinedStorageAvailable())throw new Error("release disabled");
  const k=key(p);const existing=inFlight.get(k);if(existing)return existing;
  const promise=(async()=>{
    const job=await getOwnedJob(p.jobId,p.installationId);
    const candidate=await loadCandidate(p.jobId,p.personIndex,p.candidateId);
    if(!job?.inputS3Key || !candidate)throw new Error("original input unavailable");
    // RC4's current extractor supports one depicted target only. Do not apply a full-cut result to one of several people.
    if(job.result?.candidatesByPerson.length!==1)throw new Error("single target required");
    const cached=await downloadRelease(p);if(cached)return cached.record;
    const image=await loadInput(job.inputS3Key);
    const raw=await releaseRefine(image,candidate.poseId);
    const withheld=held.safeParse(raw);if(withheld.success)return withheld.data;
    const record=accepted.parse(raw);
    const exposed=job.result?.candidatesByPerson.find(v=>v.personIndex===p.personIndex)?.candidates.find(v=>v.id===p.candidateId);
    if(!record.source || record.source.pose_id!==candidate.poseId || record.source.identity.bvh_sha256!==exposed?.sourceBvhSha256)throw new Error("original source receipt mismatch");
    const bytes=await releaseFbx(record.handle);
    if(digest(bytes)!==record.artifact_sha256 || Buffer.from(bytes.subarray(0,18)).toString()!=="Kaydara FBX Binary")throw new Error("artifact integrity failed");
    if(!(await getOwnedJob(p.jobId,p.installationId)))throw new Error("job deleted");
    const preview=await releasePreview(record.handle);
    if(digest(preview)!==record.preview_sha256)throw new Error("preview integrity failed");
    await putRefinedBvh(k+".glb",preview);
    await putRefinedBvh(k+".fbx",bytes);
    await putRefinedBvh(k+".json",Buffer.from(JSON.stringify(record)));
    return record;
  })();
  inFlight.set(k,promise);try{return await promise;}finally{inFlight.delete(k);}
}
