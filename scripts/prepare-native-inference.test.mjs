import assert from 'node:assert/strict';
import test from 'node:test';

import {
  orchestrateNativeInferencePreparation,
  parseNativeInferenceArgs,
} from './prepare-native-inference.mjs';

test('native inference preparation owns one lock and passes the document runtime directly to speech', async () => {
  const events = [];
  const runtime = Object.freeze({
    target: 'x86_64-apple-darwin',
    path: '/prepared/document/libonnxruntime.dylib',
  });
  const options = parseNativeInferenceArgs(
    ['x86_64-apple-darwin', '--offline'],
    {},
  );

  const result = await orchestrateNativeInferencePreparation({
    options,
    resourceCacheRoot: '/cache',
    withLock: async (root, action) => {
      events.push(['lock', root]);
      return action();
    },
    prepareDocumentProcessing: async (receivedOptions) => {
      events.push(['document', receivedOptions]);
      return Object.freeze({
        target: receivedOptions.target,
        needsBuild: false,
        runtime,
      });
    },
    prepareSpeechInference: async (receivedOptions, documentResult) => {
      events.push(['speech', receivedOptions, documentResult.runtime]);
      return Object.freeze({
        target: receivedOptions.target,
        needsBuild: false,
      });
    },
  });

  assert.deepEqual(result, {
    target: 'x86_64-apple-darwin',
    needsBuild: false,
  });
  assert.deepEqual(events, [
    ['lock', '/cache'],
    ['document', options],
    ['speech', options, runtime],
  ]);
});

test('native inference arguments define one target and reject conflicting preflight modes', () => {
  assert.deepEqual(
    parseNativeInferenceArgs(['aarch64-apple-darwin'], {
      MYAGENTS_NATIVE_RESOURCES_OFFLINE: '1',
    }),
    {
      target: 'aarch64-apple-darwin',
      force: false,
      checkPrerequisites: false,
      offlineRequested: false,
      documentOffline: false,
      speechOffline: true,
    },
  );
  assert.throws(
    () =>
      parseNativeInferenceArgs([
        'aarch64-apple-darwin',
        '--check-prerequisites',
        '--offline',
      ]),
    /cannot be combined/,
  );
  assert.throws(() => parseNativeInferenceArgs(['a', 'b']), /Usage:/);
});
