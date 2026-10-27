# App body runtime snapshot

Read-only server preview reuses the app’s parser and numeric mesh evaluators. Source commit and unmodified-source checksums are in SOURCE.json. Only relative import extensions change for NodeNext. It supports SSR1 rules and SSR2 sampled assets; no model data is bundled. Catalog/runtime/source hashes must match before evaluation. When the client controller changes, update this snapshot and the Blender-reference fixtures together.
