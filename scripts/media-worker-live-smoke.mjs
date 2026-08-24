import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [
  workerPath,
  nativeManifestPath,
  runtimePath,
  modelManifestPath,
  wavPath,
] = process.argv.slice(2);
if (
  !workerPath ||
  !nativeManifestPath ||
  !runtimePath ||
  !modelManifestPath ||
  !wavPath
) {
  throw new Error(
    "Usage: node scripts/media-worker-live-smoke.mjs <worker> <native-manifest> <onnx-runtime> <model-manifest> <16k-mono-pcm16.wav>",
  );
}

const PROTOCOL_VERSION = 1;
const MAX_CONTROL_BYTES = 256 * 1024;
const identity = { workloadId: "record_smoke", workerGeneration: 1 };

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

function pcmFrame(sequence, startSample, samples) {
  const payload = Buffer.alloc(34 + samples.length * 2);
  payload[0] = 2;
  payload.writeUInt32BE(PROTOCOL_VERSION, 1);
  payload.writeBigUInt64BE(BigInt(identity.workerGeneration), 5);
  payload[13] = 1; // microphone
  payload.writeBigUInt64BE(BigInt(sequence), 14);
  payload.writeBigUInt64BE(BigInt(startSample), 22);
  payload.writeUInt32BE(samples.length, 30);
  for (let index = 0; index < samples.length; index += 1) {
    payload.writeInt16LE(samples[index], 34 + index * 2);
  }
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  return Buffer.concat([prefix, payload]);
}

function readPcm16Wave(path) {
  const wave = readFileSync(path);
  if (
    wave.toString("ascii", 0, 4) !== "RIFF" ||
    wave.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Smoke input is not a RIFF/WAVE file");
  }
  let format;
  let data;
  let offset = 12;
  while (offset + 8 <= wave.length) {
    const id = wave.toString("ascii", offset, offset + 4);
    const size = wave.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > wave.length) {
      throw new Error("Smoke WAVE chunk is truncated");
    }
    if (id === "fmt " && size >= 16) {
      format = {
        codec: wave.readUInt16LE(body),
        channels: wave.readUInt16LE(body + 2),
        sampleRate: wave.readUInt32LE(body + 4),
        bitsPerSample: wave.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = wave.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  if (
    !format ||
    !data ||
    format.codec !== 1 ||
    format.channels !== 1 ||
    format.sampleRate !== 16_000 ||
    format.bitsPerSample !== 16 ||
    data.length % 2 !== 0
  ) {
    throw new Error("Smoke input must be 16 kHz mono PCM16 WAVE");
  }
  return new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2);
}

const samples = readPcm16Wave(wavPath);
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

const timeout = setTimeout(() => child.kill(), 30_000);
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

async function write(frame) {
  if (!child.stdin.write(frame)) await once(child.stdin, "drain");
}

await write(
  controlFrame({
    type: "start",
    protocolVersion: PROTOCOL_VERSION,
    identity,
    workloadKind: "record_live_asr",
    input: {
      type: "live_pcm",
      streams: [
        {
          track: "microphone",
          firstSequence: 0,
          firstSample: 0,
        },
      ],
    },
    nativeManifestPath,
    onnxRuntimePath: runtimePath,
    modelPackManifestPath: modelManifestPath,
  }),
);
await waitForResponse("ready");
let sequence = 0;
for (let start = 0; start < samples.length; start += 16_000) {
  const sentSequence = sequence;
  await write(
    pcmFrame(
      sentSequence,
      start,
      samples.subarray(start, Math.min(start + 16_000, samples.length)),
    ),
  );
  await waitForResponse(
    "input_ack",
    (response) => response.sequence === sentSequence,
  );
  sequence += 1;
}
await write(
  controlFrame({
    type: "finalize",
    protocolVersion: PROTOCOL_VERSION,
    identity,
    streams: [
      {
        track: "microphone",
        lastSequence: sequence === 0 ? null : sequence - 1,
        finalSample: samples.length,
      },
    ],
  }),
);
await waitForResponse("completed");
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
const result = {
  exitCode,
  signal,
  counts,
  transcriptBytes: transcript ? Buffer.byteLength(transcript.text) : 0,
  language: transcript?.language,
  completedMetrics: completed?.metrics,
  stderrBytes,
};
console.log(JSON.stringify(result));
if (
  exitCode !== 0 ||
  signal !== null ||
  stderrBytes !== 0 ||
  !transcript ||
  !completed ||
  counts.ready !== 1 ||
  counts.input_ack !== sequence
) {
  throw new Error(
    "Media Worker live smoke did not reach the expected terminal state",
  );
}
