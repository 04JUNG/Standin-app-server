# Scene camera receipt and total request budget

Clients may send `cameraContractVersion: "scene-camera-artifact-v1"` with the
existing `csp-scene-manifest-v1` prepare, preview, metadata and release requests.
Keep it on subsequent requests: the negotiated camera contract is part of the
snapshot binding. Unknown versions are rejected. Requests without it retain the
legacy unavailable-camera metadata, so deploying this BFF does not break old clients.

The Converter's binary header and v4 build's `camera` object bind the recipe to
the final FBX SHA. The BFF checks size bounds, finite values, source dimensions,
centered projection, camera/focal point and optics consistency. Present malformed
data fails integrity validation. Old workers/Converters without camera metadata
remain usable with an explicit unavailable state.

When negotiated and verified, `manifest.camera` contains:

```text
version: scene-camera-v1
status: available
reason: null
artifactSha256: <same SHA as manifest.artifact.sha256>
recipe: <complete scene-camera-v1 from the compiler>
applicationRequired: true
automaticApplication: unsupported
cspValidation: unverified
```

The same camera survives immutable shared receipts and replica changes. New
clients save it in the `.scene.json` sidecar next to the matching FBX. The BFF
does not calculate a replacement camera or claim CSP application.

## One scene deadline

The route now shares one deadline (configured `SCENE_REFINEMENT_TIMEOUT_MS`,
capped at 900000ms) across original input checks, selected artifact authorization,
plan, per-person conversion, build, final checks and receipt publication. Internal
worker requests and conversion requests receive that same abort signal. The
900-second budget does not restart for every plan/build stage.

Timeout returns `SCENE_TIMEOUT` with `serverOperationMayContinue=true`; it cannot
prove that an upstream native Blender/model operation stopped. No new downstream
stage or successful file release is admitted after deadline expiry. An in-flight
immutable storage write may still finish without releasing a review key. This
does not alter inference `/analyze` deadlines or provide background job polling.

Staging ALB must retain its 930-second idle timeout. Production configuration,
worker assets/URL/token and feature activation are separate deployment decisions.

## Validation limits

Handler integration tests use synthetic FBX/worker/Converter boundaries and verify
both save modes, cross-replica camera preservation, old-client negotiation and
deadline behavior. They are not actual AWS/CSP acceptance. Capture-to-document
mapping and a reliable automatic CSP camera adapter remain unimplemented.
