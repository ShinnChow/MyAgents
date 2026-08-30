import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hostDocumentTarget,
  withResourcePrepareLock,
} from './document-processing-resource-cache.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cacheRoot = join(
  projectRoot,
  'src-tauri',
  'resources',
  'document-processing-cache',
);

export function parseNativeInferenceArgs(args, env = process.env) {
  const positional = args.filter((argument) => !argument.startsWith('--'));
  const unknownFlags = args.filter(
    (argument) =>
      argument.startsWith('--') &&
      !['--force', '--offline', '--check-prerequisites'].includes(argument),
  );
  if (positional.length > 1 || unknownFlags.length > 0) {
    throw new Error(
      'Usage: node scripts/prepare-native-inference.mjs [target] [--force] [--offline] [--check-prerequisites]',
    );
  }

  const force = args.includes('--force');
  const checkPrerequisites = args.includes('--check-prerequisites');
  const offlineRequested = args.includes('--offline');
  if (checkPrerequisites && (force || offlineRequested)) {
    throw new Error(
      '--check-prerequisites cannot be combined with --force or --offline',
    );
  }

  return Object.freeze({
    target: positional[0] ?? hostDocumentTarget(),
    force,
    checkPrerequisites,
    offlineRequested,
    documentOffline:
      offlineRequested || env.MYAGENTS_DOCUMENT_RESOURCES_OFFLINE === '1',
    speechOffline:
      offlineRequested ||
      env.MYAGENTS_NATIVE_RESOURCES_OFFLINE === '1' ||
      env.MYAGENTS_DOCUMENT_RESOURCES_OFFLINE === '1',
  });
}

export async function orchestrateNativeInferencePreparation({
  options,
  prepareDocumentProcessing,
  prepareSpeechInference,
  withLock = withResourcePrepareLock,
  resourceCacheRoot = cacheRoot,
}) {
  return withLock(
    resourceCacheRoot,
    async () => {
      const documentResult = await prepareDocumentProcessing(options);
      return prepareSpeechInference(options, documentResult);
    },
    {
      onWait: () =>
        console.log(
          '  [lock] another native resource preparation is active; waiting...',
        ),
    },
  );
}

export async function prepareNativeInference(args = process.argv.slice(2)) {
  const options = parseNativeInferenceArgs(args);
  const [{ prepareDocumentProcessing }, { prepareSpeechInference }] =
    await Promise.all([
      import('./prepare-document-processing.mjs'),
      import('./prepare-speech-inference.mjs'),
    ]);
  return orchestrateNativeInferencePreparation({
    options,
    prepareDocumentProcessing,
    prepareSpeechInference,
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await prepareNativeInference();
}
