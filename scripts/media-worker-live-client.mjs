import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const PROTOCOL_VERSION = 1;
const MAX_CONTROL_BYTES = 256 * 1024;
const SAMPLE_RATE = 16_000;
const MAX_FRAME_SAMPLES = 5 * SAMPLE_RATE;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

function controlFrame(value) {
  const json = Buffer.from(JSON.stringify(value));
  if (json.length === 0 || json.length > MAX_CONTROL_BYTES) {
    throw new Error("Live Worker control frame exceeds the protocol limit");
  }
  const payload = Buffer.concat([Buffer.from([1]), json]);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  return Buffer.concat([prefix, payload]);
}

function pcmFrame(identity, sequence, startSample, samples) {
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

export function readPcm16Wave(path) {
  const wave = readFileSync(path);
  if (
    wave.toString("ascii", 0, 4) !== "RIFF" ||
    wave.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Live Worker input is not a RIFF/WAVE file");
  }
  let format;
  let data;
  let offset = 12;
  while (offset + 8 <= wave.length) {
    const id = wave.toString("ascii", offset, offset + 4);
    const size = wave.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > wave.length) {
      throw new Error("Live Worker WAVE chunk is truncated");
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
    format.sampleRate !== SAMPLE_RATE ||
    format.bitsPerSample !== 16 ||
    data.length % 2 !== 0
  ) {
    throw new Error("Live Worker input must be 16 kHz mono PCM16 WAVE");
  }
  return new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2);
}

function validateMeasurementWindows(windows, sampleCount) {
  if (!Array.isArray(windows) || windows.length > 10_000) {
    throw new Error("Invalid live Worker measurement windows");
  }
  const ids = new Set();
  let previousEnd = 0;
  for (const window of windows) {
    if (
      !window ||
      typeof window !== "object" ||
      !SAFE_ID.test(window.id ?? "") ||
      ids.has(window.id) ||
      !Number.isSafeInteger(window.startSample) ||
      !Number.isSafeInteger(window.endSample) ||
      !Number.isSafeInteger(window.lastValidSpeechSample) ||
      window.startSample < previousEnd ||
      window.startSample >= window.lastValidSpeechSample ||
      window.lastValidSpeechSample >= window.endSample ||
      window.endSample > sampleCount
    ) {
      throw new Error("Invalid live Worker measurement window");
    }
    ids.add(window.id);
    previousEnd = window.endSample;
  }
}

function extractLiveMeasurements({
  windows,
  timeline,
  deliveredAt,
  finalizeSentAtMs,
}) {
  if (windows.length === 0) return [];
  const transcriptEntries = timeline.filter(
    (entry) => entry.response.type === "transcript_segment",
  );
  const measurements = windows.map((window, measurementIndex) => {
    const matches = transcriptEntries.filter(
      ({ response }) =>
        response.startSample >= window.startSample &&
        response.endSample <= window.endSample &&
        response.startSample < window.lastValidSpeechSample &&
        response.endSample >= window.lastValidSpeechSample,
    );
    if (matches.length !== 1) {
      const ranges = transcriptEntries.map(({ response }) => [
        response.startSample,
        response.endSample,
      ]);
      throw new Error(
        `Live Worker measurement ${window.id} did not produce one stable segment: matches=${matches.length}, ranges=${JSON.stringify(ranges)}`,
      );
    }
    const transcript = matches[0];
    if (transcript.receivedAtMs >= finalizeSentAtMs) {
      throw new Error(
        `Live Worker measurement ${window.id} required terminal flush`,
      );
    }
    const transcriptIndex = timeline.indexOf(transcript);
    let ack;
    for (let index = transcriptIndex - 1; index >= 0; index -= 1) {
      if (timeline[index].response.type === "input_ack") {
        ack = timeline[index];
        break;
      }
    }
    const lastSpeechDeliveredAtMs = deliveredAt.get(window.id);
    if (
      !ack ||
      !Number.isFinite(lastSpeechDeliveredAtMs) ||
      ack.response.endSample < window.lastValidSpeechSample ||
      ack.response.endSample > window.endSample ||
      ack.receivedAtMs < lastSpeechDeliveredAtMs ||
      transcript.receivedAtMs < ack.receivedAtMs
    ) {
      throw new Error(
        `Live Worker measurement ${window.id} has invalid boundary timing`,
      );
    }
    const rounded = (value) => Math.round(value * 1_000) / 1_000;
    return {
      id: window.id,
      cold: measurementIndex === 0,
      lastValidSpeechSample: window.lastValidSpeechSample,
      vadConfirmedSample: ack.response.endSample,
      segmentStartSample: transcript.response.startSample,
      segmentEndSample: transcript.response.endSample,
      transcriptBytes: Buffer.byteLength(transcript.response.text),
      lastSpeechToVadMs: rounded(ack.receivedAtMs - lastSpeechDeliveredAtMs),
      vadToSegmentFinalMs: rounded(transcript.receivedAtMs - ack.receivedAtMs),
      lastSpeechToSegmentFinalMs: rounded(
        transcript.receivedAtMs - lastSpeechDeliveredAtMs,
      ),
    };
  });
  if (transcriptEntries.length !== measurements.length) {
    throw new Error("Live Worker emitted an unmeasured transcript segment");
  }
  return measurements;
}

export async function runMediaWorkerLive({
  workerPath,
  nativeManifestPath,
  onnxRuntimePath,
  modelManifestPath,
  samples,
  measurementWindows = [],
  frameSamples = SAMPLE_RATE,
  realtime = false,
  timeoutMs = 30_000,
  terminationGraceMs = 2_000,
  workloadId = "record_live_smoke",
  workerGeneration = 1,
}) {
  if (
    !workerPath ||
    !nativeManifestPath ||
    !onnxRuntimePath ||
    !modelManifestPath ||
    !(samples instanceof Int16Array) ||
    samples.length === 0 ||
    !Number.isSafeInteger(frameSamples) ||
    frameSamples <= 0 ||
    frameSamples > MAX_FRAME_SAMPLES ||
    typeof realtime !== "boolean" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(terminationGraceMs) ||
    terminationGraceMs <= 0 ||
    terminationGraceMs > 60_000 ||
    !SAFE_ID.test(workloadId) ||
    !Number.isSafeInteger(workerGeneration) ||
    workerGeneration <= 0
  ) {
    throw new Error("Invalid Media Worker live client arguments");
  }
  validateMeasurementWindows(measurementWindows, samples.length);

  const identity = { workloadId, workerGeneration };
  const workerSpawnedAtMs = performance.now();
  const child = spawn(workerPath, [], { stdio: ["pipe", "pipe", "pipe"] });
  const responses = [];
  const timeline = [];
  const responseEvents = new EventEmitter();
  let stdoutBuffer = Buffer.alloc(0);
  let stderrBytes = 0;
  let protocolError;
  let primaryError;
  let result;

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
        const response = JSON.parse(payload.subarray(1).toString("utf8"));
        if (
          response.protocolVersion !== PROTOCOL_VERSION ||
          response.identity?.workloadId !== identity.workloadId ||
          response.identity?.workerGeneration !== identity.workerGeneration
        ) {
          throw new Error(
            "Worker response identity does not match the request",
          );
        }
        responses.push(response);
        timeline.push({ response, receivedAtMs: performance.now() });
        responseEvents.emit("response");
      }
    } catch (error) {
      protocolError = error;
      responseEvents.emit("response");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
  });

  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Media Worker timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  const childError = once(child, "error").then(([error]) => {
    throw error;
  });
  const childExit = once(child, "close").then(([exitCode, signal]) => ({
    exitCode,
    signal,
  }));
  const childTermination = Promise.race([childExit, childError]);

  async function settleWithin(milliseconds) {
    let timer;
    try {
      return await Promise.race([
        childTermination.then(
          (value) => ({ settled: true, value }),
          (error) => ({ settled: true, error }),
        ),
        new Promise((resolvePromise) => {
          timer = setTimeout(
            () => resolvePromise({ settled: false }),
            milliseconds,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function terminateAndWait() {
    let settlement = await settleWithin(0);
    if (settlement.settled) return;
    child.kill("SIGTERM");
    settlement = await settleWithin(terminationGraceMs);
    if (settlement.settled) return;
    child.kill("SIGKILL");
    settlement = await settleWithin(terminationGraceMs);
    if (!settlement.settled) {
      throw new Error("Media Worker did not exit after forced termination");
    }
  }

  async function waitForResponse(type, predicate = () => true) {
    while (true) {
      const failed = responses.find((candidate) => candidate.type === "failed");
      if (protocolError) throw protocolError;
      if (failed && type !== "failed") {
        throw new Error(`Worker failed before ${type}: ${failed.code}`);
      }
      const entry = timeline.find(
        (candidate) =>
          candidate.response.type === type && predicate(candidate.response),
      );
      if (entry) return entry;
      await Promise.race([
        once(responseEvents, "response"),
        childTermination.then(({ exitCode, signal }) => {
          throw new Error(
            `Worker exited before ${type}: exit=${exitCode}, signal=${signal}`,
          );
        }),
        deadline,
      ]);
    }
  }

  async function write(frame) {
    if (!child.stdin.write(frame)) {
      await Promise.race([
        once(child.stdin, "drain"),
        childTermination,
        deadline,
      ]);
    }
  }

  async function delayUntil(targetMs) {
    const delayMs = targetMs - performance.now();
    if (delayMs <= 0) return;
    await Promise.race([
      new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs)),
      childTermination,
      deadline,
    ]);
  }

  try {
    await write(
      controlFrame({
        type: "start",
        protocolVersion: PROTOCOL_VERSION,
        identity,
        workloadKind: "record_live_asr",
        input: {
          type: "live_pcm",
          streams: [{ track: "microphone", firstSequence: 0, firstSample: 0 }],
        },
        nativeManifestPath,
        onnxRuntimePath,
        modelPackManifestPath: modelManifestPath,
      }),
    );
    const ready = await waitForResponse("ready");
    const workerReadyMs = ready.receivedAtMs - workerSpawnedAtMs;
    const streamStartedAtMs = realtime ? workerSpawnedAtMs : performance.now();
    const deliveredAt = new Map();
    const measurementPoints = new Map(
      measurementWindows.map((window) => [
        window.lastValidSpeechSample,
        window.id,
      ]),
    );
    const splitPoints = [...measurementPoints.keys()].sort(
      (left, right) => left - right,
    );
    let splitIndex = 0;
    let sequence = 0;
    for (let startSample = 0; startSample < samples.length; ) {
      while (splitPoints[splitIndex] <= startSample) splitIndex += 1;
      const nextSplit = splitPoints[splitIndex] ?? samples.length;
      const endSample = Math.min(
        samples.length,
        startSample + frameSamples,
        nextSplit,
      );
      if (realtime) {
        await delayUntil(streamStartedAtMs + (endSample * 1_000) / SAMPLE_RATE);
      }
      await write(
        pcmFrame(
          identity,
          sequence,
          startSample,
          samples.subarray(startSample, endSample),
        ),
      );
      if (measurementPoints.has(endSample)) {
        deliveredAt.set(
          measurementPoints.get(endSample),
          realtime
            ? streamStartedAtMs + (endSample * 1_000) / SAMPLE_RATE
            : performance.now(),
        );
      }
      await waitForResponse(
        "input_ack",
        (response) =>
          response.sequence === sequence && response.endSample === endSample,
      );
      await waitForResponse(
        "heartbeat",
        (response) =>
          response.checkpoint?.streams?.some(
            (stream) =>
              stream.track === "microphone" &&
              stream.lastAckSequence === sequence &&
              stream.analysisSample === endSample,
          ) === true,
      );
      startSample = endSample;
      sequence += 1;
    }
    const finalizeSentAtMs = performance.now();
    await write(
      controlFrame({
        type: "finalize",
        protocolVersion: PROTOCOL_VERSION,
        identity,
        streams: [
          {
            track: "microphone",
            lastSequence: sequence - 1,
            finalSample: samples.length,
          },
        ],
      }),
    );
    await waitForResponse("completed");
    child.stdin.end();
    const { exitCode, signal } = await Promise.race([
      childTermination,
      deadline,
    ]);
    if (protocolError) throw protocolError;
    if (stdoutBuffer.length !== 0) {
      throw new Error("Worker response stream ended with a partial frame");
    }
    result = {
      responses,
      exitCode,
      signal,
      stderrBytes,
      frameCount: sequence,
      sampleCount: samples.length,
      workerReadyMs: Math.round(workerReadyMs * 1_000) / 1_000,
      measurements: extractLiveMeasurements({
        windows: measurementWindows,
        timeline,
        deliveredAt,
        finalizeSentAtMs,
      }),
    };
  } catch (error) {
    primaryError = error;
  }
  clearTimeout(timeout);
  let cleanupError;
  try {
    await terminateAndWait();
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError) {
    if (cleanupError && primaryError instanceof Error) {
      primaryError.message = `${primaryError.message}; cleanup failed: ${cleanupError.message}`;
    }
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  return result;
}

export function assertExpectedMediaWorkerLive(
  result,
  expectedMeasurements = 0,
) {
  const counts = Object.create(null);
  for (const response of result.responses) {
    counts[response.type] = (counts[response.type] ?? 0) + 1;
  }
  const transcript = result.responses.find(
    (response) => response.type === "transcript_segment",
  );
  const completed = result.responses.find(
    (response) => response.type === "completed",
  );
  if (
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.stderrBytes !== 0 ||
    counts.ready !== 1 ||
    counts.input_ack !== result.frameCount ||
    counts.heartbeat !== result.frameCount ||
    !transcript ||
    counts.completed !== 1 ||
    counts.failed ||
    completed.metrics?.sourceSamples !== result.sampleCount ||
    completed.metrics?.segments !== counts.transcript_segment ||
    result.measurements.length !== expectedMeasurements
  ) {
    throw new Error(
      "Media Worker live run did not reach the expected terminal state",
    );
  }
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    counts,
    transcriptBytes: Buffer.byteLength(transcript.text),
    language: transcript.language,
    completedMetrics: completed.metrics,
    workerReadyMs: result.workerReadyMs,
    stderrBytes: result.stderrBytes,
    measurements: result.measurements,
  };
}
