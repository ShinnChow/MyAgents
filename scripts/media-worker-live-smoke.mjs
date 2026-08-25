import {
  assertExpectedMediaWorkerLive,
  readPcm16Wave,
  runMediaWorkerLive,
} from "./media-worker-live-client.mjs";

const [
  workerPath,
  nativeManifestPath,
  onnxRuntimePath,
  modelManifestPath,
  wavPath,
] = process.argv.slice(2);
if (
  !workerPath ||
  !nativeManifestPath ||
  !onnxRuntimePath ||
  !modelManifestPath ||
  !wavPath
) {
  throw new Error(
    "Usage: node scripts/media-worker-live-smoke.mjs <worker> <native-manifest> <onnx-runtime> <model-manifest> <16k-mono-pcm16.wav>",
  );
}

const result = await runMediaWorkerLive({
  workerPath,
  nativeManifestPath,
  onnxRuntimePath,
  modelManifestPath,
  samples: readPcm16Wave(wavPath),
});
const summary = assertExpectedMediaWorkerLive(result);
console.log(
  JSON.stringify({
    exitCode: summary.exitCode,
    signal: summary.signal,
    counts: summary.counts,
    transcriptBytes: summary.transcriptBytes,
    language: summary.language,
    completedMetrics: summary.completedMetrics,
    stderrBytes: summary.stderrBytes,
  }),
);
