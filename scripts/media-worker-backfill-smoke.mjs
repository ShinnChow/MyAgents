import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";

const [
  workerPath,
  nativeManifestPath,
  runtimePath,
  modelManifestPath,
  recordOpusPath,
  requestedMode,
] = process.argv.slice(2);
const mode = requestedMode ?? "complete";
if (
  !workerPath ||
  !nativeManifestPath ||
  !runtimePath ||
  !modelManifestPath ||
  !recordOpusPath ||
  !["complete", "yield", "cancel"].includes(mode)
) {
  throw new Error(
    "Usage: node scripts/media-worker-backfill-smoke.mjs <worker> <native-manifest> <onnx-runtime> <model-manifest> <record.opus> [complete|yield|cancel]",
  );
}

const PROTOCOL_VERSION = 1;
const MAX_CONTROL_BYTES = 256 * 1024;
const identity = { workloadId: "record_backfill_smoke", workerGeneration: 1 };

function controlFrame(value) {
  const json = Buffer.from(JSON.stringify(value));
  if (json.length === 0 || json.length > MAX_CONTROL_BYTES) {
    throw new Error("Smoke control frame exceeds the Worker protocol limit");
  }
  const payload = Buffer.concat([Buffer.from([1]), json]);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  return Buffer.concat([prefix, payload]);
}

const child = spawn(workerPath, [], { stdio: ["pipe", "pipe", "pipe"] });
const responses = [];
const responseEvents = new EventEmitter();
let stdoutBuffer = Buffer.alloc(0);
let stderrBytes = 0;
let protocolError;

child.stdout.on("data", (chunk) => {
  if (protocolError) return;
  stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
  try {
    while (stdoutBuffer.length >= 4) {
      const length = stdoutBuffer.readUInt32BE(0);
      if (length === 0 || length > MAX_CONTROL_BYTES + 1) {
        throw new Error("Worker emitted an oversized control frame");
      }
      if (stdoutBuffer.length < 4 + length) break;
      const payload = stdoutBuffer.subarray(4, 4 + length);
      stdoutBuffer = stdoutBuffer.subarray(4 + length);
      if (payload[0] !== 1) {
        throw new Error("Worker emitted a non-control response");
      }
      responses.push(JSON.parse(payload.subarray(1).toString("utf8")));
      responseEvents.emit("response");
    }
  } catch (error) {
    protocolError = error;
    child.kill();
  }
});
child.stderr.on("data", (chunk) => {
  stderrBytes += chunk.length;
});

const timeout = setTimeout(() => child.kill(), 45_000);
const childError = once(child, "error").then(([error]) => {
  throw error;
});
const childExit = once(child, "exit").then(([exitCode, signal]) => ({
  exitCode,
  signal,
}));
const childTermination = Promise.race([childExit, childError]);

async function waitForResponse(type, predicate = () => true) {
  while (true) {
    const response = responses.find(
      (candidate) => candidate.type === type && predicate(candidate),
    );
    if (response) return response;
    await Promise.race([
      once(responseEvents, "response"),
      childTermination.then(({ exitCode, signal }) => {
        throw new Error(
          `Worker exited before ${type}: exit=${exitCode}, signal=${signal}`,
        );
      }),
    ]);
  }
}

async function write(value) {
  if (!child.stdin.write(controlFrame(value))) {
    await once(child.stdin, "drain");
  }
}

await write({
  type: "start",
  protocolVersion: PROTOCOL_VERSION,
  identity,
  workloadKind: "record_backfill_asr",
  input: {
    type: "record_artifacts",
    inputs: [{ track: "microphone", inputPath: recordOpusPath }],
  },
  nativeManifestPath,
  onnxRuntimePath: runtimePath,
  modelPackManifestPath: modelManifestPath,
});
await waitForResponse("ready");
if (mode === "complete") {
  await write({
    type: "ping",
    protocolVersion: PROTOCOL_VERSION,
    identity,
    nonce: 42,
  });
  await waitForResponse("pong", (response) => response.nonce === 42);
  await waitForResponse("completed");
} else {
  await write({
    type: mode,
    protocolVersion: PROTOCOL_VERSION,
    identity,
  });
  await waitForResponse(mode === "yield" ? "yielded" : "failed");
}
child.stdin.end();

const { exitCode, signal } = await childTermination;
clearTimeout(timeout);
if (protocolError) throw protocolError;
if (stdoutBuffer.length !== 0) {
  throw new Error("Worker response stream ended with a partial frame");
}

const counts = Object.create(null);
for (const response of responses) {
  counts[response.type] = (counts[response.type] ?? 0) + 1;
}
const transcript = responses.find(
  (response) => response.type === "transcript_segment",
);
const completed = responses.find((response) => response.type === "completed");
const yielded = responses.find((response) => response.type === "yielded");
const failed = responses.find((response) => response.type === "failed");
const result = {
  mode,
  exitCode,
  signal,
  counts,
  transcriptBytes: transcript ? Buffer.byteLength(transcript.text) : 0,
  language: transcript?.language,
  completedMetrics: completed?.metrics,
  stderrBytes,
};
console.log(JSON.stringify(result));
const invalidComplete =
  mode === "complete" &&
  (!transcript ||
    !completed ||
    counts.ready !== 1 ||
    counts.pong !== 1 ||
    counts.yielded ||
    counts.failed);
const invalidYield =
  mode === "yield" &&
  (counts.ready !== 1 ||
    counts.yielded !== 1 ||
    yielded?.checkpoint?.streams?.length !== 1 ||
    counts.completed ||
    counts.failed);
const invalidCancel =
  mode === "cancel" &&
  (counts.ready !== 1 ||
    counts.failed !== 1 ||
    failed?.code !== "SPEECH_CANCELLED" ||
    counts.completed ||
    counts.yielded);
if (
  exitCode !== 0 ||
  signal !== null ||
  stderrBytes !== 0 ||
  invalidComplete ||
  invalidYield ||
  invalidCancel
) {
  throw new Error(
    "Media Worker Record backfill smoke did not reach the expected terminal state",
  );
}
