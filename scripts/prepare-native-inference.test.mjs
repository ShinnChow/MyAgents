import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ensureLockedGitCheckout } from './prepare-document-processing.mjs';
import {
  orchestrateNativeInferencePreparation,
  parseNativeInferenceArgs,
} from './prepare-native-inference.mjs';
import {
  MINIMUM_SPEECH_CMAKE_VERSION,
  speechBuildPrerequisiteFailures,
} from './prepare-speech-inference.mjs';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(cwd, message) {
  git(cwd, [
    '-c',
    'user.name=MyAgents Test',
    '-c',
    'user.email=myagents-test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    message,
  ]);
}

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

test('speech preflight enforces the native adapter CMake floor', () => {
  const completeTools = {
    cmakeVersion: 'cmake version 3.28.0',
    cargoVersion: 'cargo 1.89.0',
    compiler: '/usr/bin/c++',
  };
  assert.equal(MINIMUM_SPEECH_CMAKE_VERSION, '3.28.0');
  assert.deepEqual(speechBuildPrerequisiteFailures(completeTools, 'linux'), []);

  const old = speechBuildPrerequisiteFailures(
    { ...completeTools, cmakeVersion: 'cmake version 3.27.9' },
    'linux',
  );
  assert.match(old[0], /CMake >= 3\.28\.0 \(found 3\.27\.9/);

  const unknown = speechBuildPrerequisiteFailures(
    { ...completeTools, cmakeVersion: 'unexpected output' },
    'linux',
  );
  assert.match(unknown[0], /could not parse/);
});

test('managed ORT source cache recovers interrupted Git states without refetching a locked HEAD', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'myagents-ort-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const upstreamWork = join(root, 'upstream-work');
  const upstreamBare = join(root, 'upstream.git');
  mkdirSync(upstreamWork);
  git(upstreamWork, ['init', '-q']);
  writeFileSync(join(upstreamWork, 'source.txt'), 'locked\n');
  git(upstreamWork, ['add', 'source.txt']);
  commit(upstreamWork, 'locked source');
  const lockedCommit = git(upstreamWork, ['rev-parse', 'HEAD']);
  git(root, ['clone', '--quiet', '--bare', upstreamWork, upstreamBare]);

  const cache = join(root, 'cache');
  mkdirSync(cache);
  git(cache, ['init', '-q']);
  ensureLockedGitCheckout(cache, upstreamBare, lockedCommit);
  assert.equal(git(cache, ['rev-parse', '--verify', 'HEAD']), lockedCommit);
  assert.equal(git(cache, ['remote', 'get-url', 'origin']), upstreamBare);

  const unavailableUpstream = join(root, 'upstream-offline.git');
  renameSync(upstreamBare, unavailableUpstream);
  try {
    assert.doesNotThrow(() =>
      ensureLockedGitCheckout(cache, upstreamBare, lockedCommit),
    );
  } finally {
    renameSync(unavailableUpstream, upstreamBare);
  }

  writeFileSync(join(cache, 'source.txt'), 'interrupted wrong checkout\n');
  git(cache, ['add', 'source.txt']);
  commit(cache, 'wrong source');
  git(cache, ['remote', 'set-url', 'origin', join(root, 'wrong-origin.git')]);
  ensureLockedGitCheckout(cache, upstreamBare, lockedCommit);
  assert.equal(git(cache, ['rev-parse', '--verify', 'HEAD']), lockedCommit);
  assert.equal(git(cache, ['remote', 'get-url', 'origin']), upstreamBare);
});
