import {
  MEDIA_WORKER_BATCH_MODES,
  assertExpectedMediaWorkerBatch,
  runMediaWorkerBatch,
} from "./media-worker-batch-client.mjs";

const [
  workerPath,
  nativeManifestPath,
  runtimePath,
  modelManifestPath,
  sourcePath,
  requestedMode,
] = process.argv.slice(2);
const mode = requestedMode ?? "complete";
if (
  !workerPath ||
  !nativeManifestPath ||
  !runtimePath ||
  !modelManifestPath ||
  !sourcePath ||
  !MEDIA_WORKER_BATCH_MODES.includes(mode)
) {
  throw new Error(
    "Usage: node scripts/media-worker-backfill-smoke.mjs <worker> <native-manifest> <onnx-runtime> <model-manifest> <source-media> [complete|yield|cancel|diarization|attachment]",
  );
}

const result = await runMediaWorkerBatch({
  workerPath,
  nativeManifestPath,
  onnxRuntimePath: runtimePath,
  modelManifestPath,
  sourcePath,
  mode,
});
const summary = assertExpectedMediaWorkerBatch(mode, result);
delete summary.yielded;
console.log(JSON.stringify(summary));
