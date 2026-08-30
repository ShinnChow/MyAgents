# Speech inference native bundle notices

MyAgents ships a target-specific media Worker and adapter under
`speech-inference/v1`. The bundle intentionally does not contain ONNX Runtime:
it references and verifies the single App-owned ONNX Runtime file from the
document-processing resource bundle.

The native speech bundle is built from the exact revisions recorded in
`src-tauri/document-worker/resource-lock.json`:

- sherpa-onnx and its C/C++ dependency graph, under their corresponding
  Apache-2.0, BSD-3-Clause, MIT, MPL-2.0, and upstream notice terms;
- `opus2` 0.4.0, `libopus_sys` 0.3.3, and bundled libopus, under their
  corresponding Apache-2.0, MIT, and BSD-style terms;
- `hdbscan` 0.12.0 and its `kdtree` 0.7.0 / `num-traits` 0.2.19 dependency
  graph, under MIT OR Apache-2.0, for Record-wide speaker clustering;
- MyAgents media Worker and stable speech adapter ABI, under AGPL-3.0-only.

The adjacent `legal/` inventory contains the exact license files copied from
the source trees used for the build. The bundle manifest hashes every native
artifact and every legal file after platform signing.
