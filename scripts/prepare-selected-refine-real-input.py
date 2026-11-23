"""Local real-coordinate QA input. Requires the inference repo's Python dependencies.

Routing control: one person/full-half/upper-only. No manual joint coordinates or mock pose.
"""
import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import shutil
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--engine-root", required=True)
parser.add_argument("--image", required=True)
parser.add_argument("--base-bvh", required=True)
parser.add_argument("--pose-id", required=True)
parser.add_argument("--out", required=True)
args = parser.parse_args()
sys.path.insert(0, str(Path(args.engine_root).resolve()))
from PIL import Image
from src.pose import RTMPoseModel
from src.pipeline import Pipeline
from src.repo import build_db, load_entries
from src.library import build_index_from_bvh_dir
from src.vlm.client import MockVLMClient

if Path(args.pose_id).name != args.pose_id or args.pose_id in {".", ".."}:
    raise ValueError("invalid pose id")
out = Path(args.out).resolve()
library = out / "library"
library.mkdir(parents=True, exist_ok=True)
base = library / f"{args.pose_id}.bvh"
shutil.copyfile(args.base_bvh, base)
build_db(build_index_from_bvh_dir(str(library)), str(out / "selected.db"))

class RoutingOnly(MockVLMClient):
    def analyze(self, image, width, height):
        result = super().analyze(image, width, height)
        result.lower_body_visible = [False]
        result.lower_body_visibility_known = [True]
        return result

image_path = Path(args.image).resolve()
image = Image.open(image_path).convert("RGB")
model = RTMPoseModel()  # Explicit real model: construction/inference failure is fatal.
result = Pipeline(load_entries(str(out / "selected.db")), vlm_client=RoutingOnly(),
                  pose_model=model).process_cut(image, image.width, image.height)
if len(result.descriptors) != 1 or not result.person_candidates[0]:
    raise RuntimeError("real extraction did not produce one supported target")
descriptor = asdict(result.descriptors[0])
def encode(value):
    if hasattr(value, "tolist"):
        return value.tolist()
    if hasattr(value, "value"):
        return value.value
    raise TypeError(type(value).__name__)

payload = {
    "image": {"width": image.width, "height": image.height, "path": str(image_path),
              "sha256": hashlib.sha256(image_path.read_bytes()).hexdigest()},
    "pose_id": args.pose_id, "base_bvh": str(base),
    "base_sha256": hashlib.sha256(base.read_bytes()).hexdigest(),
    "descriptor": descriptor,
    "coordinate_source": "RTMPoseModel current-x; no manual joint coordinates",
    "routing_control": "one person/full_half/lower-body hidden fixed in local QA; no paid VLM call",
    "search": asdict(result.person_candidates[0][0]),
}
(out / "real-input.json").write_text(json.dumps(payload, default=encode, indent=2))
print("Real model input saved; routing fixed, joint coordinates unmodified")
