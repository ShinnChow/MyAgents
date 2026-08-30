import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { sha256File } from './document-processing-resource-cache.mjs';

export const REQUIRED_SPEECH_DEPENDENCY_IDS = [
  'eigen',
  'hclust-cpp',
  'kaldi-decoder',
  'kaldi-native-fbank',
  'kaldifst',
  'kissfft',
  'nlohmann-json',
  'openfst',
  'simple-sentencepiece',
];

export const REQUIRED_SPEECH_LEGAL_FILES = [
  'HDBSCAN-LICENSE-APACHE',
  'HDBSCAN-LICENSE-MIT',
  'KDTREE-LICENSE-APACHE',
  'KDTREE-LICENSE-MIT',
  'LIBOPUS-LICENSE',
  'LIBOPUS-SYS-LICENSE',
  'NUM-TRAITS-LICENSE-APACHE',
  'NUM-TRAITS-LICENSE-MIT',
  'OPUS2-LICENSE-APACHE',
  'OPUS2-LICENSE-MIT',
  'SHERPA-ONNX-LICENSE',
  'SPEECH_INFERENCE_NOTICES.md',
];

export function validateDocumentRuntimeDescriptor(runtime, expected) {
  if (
    runtime?.target !== expected.target ||
    runtime.platform !== expected.platform ||
    runtime.architecture !== expected.architecture ||
    runtime.license !== 'MIT' ||
    runtime.upstreamRevision !== expected.upstreamRevision ||
    typeof runtime.bundleRoot !== 'string' ||
    runtime.bundleRoot.length === 0 ||
    typeof runtime.path !== 'string' ||
    runtime.path.length === 0 ||
    !/^[0-9a-f]{64}$/.test(runtime.sha256 ?? '') ||
    !Number.isSafeInteger(runtime.size) ||
    runtime.size <= 0
  ) {
    throw new Error(
      `Document-processing ONNX Runtime does not match speech target ${expected.target}`,
    );
  }
  const root = resolve(runtime.bundleRoot);
  const path = resolve(runtime.path);
  if (!path.startsWith(`${root}${sep}`)) {
    throw new Error('Document-processing ONNX Runtime path is unsafe');
  }
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size !== runtime.size ||
    sha256File(path) !== runtime.sha256
  ) {
    throw new Error('Document-processing ONNX Runtime integrity mismatch');
  }
  return Object.freeze({ ...runtime, path });
}

function validLockedSource(entry) {
  return (
    typeof entry?.url === 'string' &&
    entry.url.length > 0 &&
    /^[0-9a-f]{64}$/.test(entry.sha256) &&
    Number.isSafeInteger(entry.size) &&
    entry.size > 0 &&
    typeof entry.archiveName === 'string' &&
    entry.archiveName.length > 0 &&
    typeof entry.license === 'string' &&
    entry.license.length > 0 &&
    typeof entry.upstreamRevision === 'string' &&
    entry.upstreamRevision.length > 0
  );
}

export function validateSpeechBuildLock(lock) {
  const speech = lock?.speechInference;
  if (
    typeof speech?.bundleVersion !== 'string' ||
    speech.bundleVersion.length === 0 ||
    speech.adapterAbiVersion !== 1 ||
    speech.sherpaOnnxVersion !== '1.13.6' ||
    !/^[0-9a-f]{40}$/.test(speech.sherpaOnnxCommit ?? '') ||
    speech.onnxRuntimeVersion !== '1.28.0' ||
    typeof speech.onnxRuntimeUpstreamRevision !== 'string' ||
    speech.onnxRuntimeUpstreamRevision.length === 0 ||
    speech.opus2Version !== '0.4.0' ||
    speech.libopusSysVersion !== '0.3.3' ||
    speech.hdbscanVersion !== '0.12.0' ||
    speech.kdtreeVersion !== '0.7.0' ||
    speech.numTraitsVersion !== '0.2.19' ||
    !Number.isSafeInteger(speech.nativeIncrementHardLimitBytes) ||
    speech.nativeIncrementHardLimitBytes <= 0 ||
    speech.nativeIncrementHardLimitBytes > 80 * 1024 * 1024 ||
    !validLockedSource(speech.source) ||
    speech.source.archiveRoot !== `sherpa-onnx-${speech.sherpaOnnxCommit}` ||
    !Array.isArray(speech.dependencies)
  ) {
    return false;
  }
  const dependencyIds = speech.dependencies.map((entry) => entry?.id).sort();
  if (
    JSON.stringify(dependencyIds) !==
      JSON.stringify(REQUIRED_SPEECH_DEPENDENCY_IDS) ||
    !speech.dependencies.every(validLockedSource)
  ) {
    return false;
  }
  const archiveNames = [
    speech.source.archiveName,
    ...speech.dependencies.map((entry) => entry.archiveName),
  ];
  return new Set(archiveNames).size === archiveNames.length;
}

function safeBundlePath(root, candidate) {
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    isAbsolute(candidate)
  ) {
    return false;
  }
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(root, candidate);
  return (
    resolvedCandidate.startsWith(`${resolvedRoot}${sep}`) &&
    relative(resolvedRoot, resolvedCandidate)
      .split(/[\\/]/)
      .every((part) => part && part !== '.' && part !== '..')
  );
}

function filesUnder(root, result = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Prepared speech bundle contains a symlink: ${path}`);
    }
    if (metadata.isDirectory()) filesUnder(path, result);
    else if (metadata.isFile()) result.push(path);
    else
      throw new Error(
        `Prepared speech bundle contains a special file: ${path}`,
      );
  }
  return result;
}

function validIntegrityFile(root, entry) {
  if (!safeBundlePath(root, entry?.path)) return false;
  const path = resolve(root, entry.path);
  const metadata = lstatSync(path);
  return (
    metadata.isFile() &&
    !metadata.isSymbolicLink() &&
    metadata.size > 0 &&
    metadata.size === entry.size &&
    /^[0-9a-f]{64}$/.test(entry.sha256 ?? '') &&
    sha256File(path) === entry.sha256
  );
}

function validNativeFile(root, entry, expectedLicense, expectedSigning) {
  return (
    validIntegrityFile(root, entry) &&
    entry.license === expectedLicense &&
    typeof entry.upstreamRevision === 'string' &&
    entry.upstreamRevision.length > 0 &&
    typeof entry.artifactSource === 'string' &&
    entry.artifactSource.length > 0 &&
    entry.signing?.kind === expectedSigning &&
    typeof entry.signing.identity === 'string' &&
    entry.signing.identity.length > 0
  );
}

export function validatePreparedSpeechBundle(root, expected) {
  try {
    if (!existsSync(root)) return false;
    const manifestPath = join(root, 'manifest.json');
    const manifestMetadata = lstatSync(manifestPath);
    if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
      return false;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (
      manifest.schemaVersion !== 1 ||
      manifest.capability !== 'speech-inference' ||
      manifest.adapterAbiVersion !== expected.adapterAbiVersion ||
      manifest.platform !== expected.platform ||
      manifest.architecture !== expected.architecture ||
      manifest.buildFingerprint !== expected.buildFingerprint ||
      manifest.framework?.sherpaOnnxVersion !== expected.sherpaOnnxVersion ||
      manifest.framework?.sherpaOnnxCommit !== expected.sherpaOnnxCommit ||
      manifest.framework?.onnxRuntimeVersion !== expected.onnxRuntimeVersion ||
      manifest.framework?.onnxRuntimeUpstreamRevision !==
        expected.onnxRuntimeUpstreamRevision
    ) {
      return false;
    }
    const fileKeys = Object.keys(manifest.files ?? {}).sort();
    if (
      JSON.stringify(fileKeys) !==
      JSON.stringify(['adapter', 'mediaWorker', 'sherpaOnnx'])
    ) {
      return false;
    }
    if (
      !validNativeFile(
        root,
        manifest.files.mediaWorker,
        'AGPL-3.0-only',
        expected.signingKind,
      ) ||
      !validNativeFile(
        root,
        manifest.files.adapter,
        'AGPL-3.0-only',
        expected.signingKind,
      ) ||
      !validNativeFile(
        root,
        manifest.files.sherpaOnnx,
        'Apache-2.0',
        expected.signingKind,
      )
    ) {
      return false;
    }
    const nativeIncrementBytes = Object.values(manifest.files).reduce(
      (sum, entry) => sum + entry.size,
      0,
    );
    if (
      manifest.nativeIncrementBytes !== nativeIncrementBytes ||
      nativeIncrementBytes <= 0 ||
      nativeIncrementBytes > expected.nativeIncrementHardLimitBytes
    ) {
      return false;
    }
    if (
      !/^[0-9a-f]{64}$/.test(manifest.onnxRuntime?.sha256 ?? '') ||
      !Number.isSafeInteger(manifest.onnxRuntime?.size) ||
      manifest.onnxRuntime.size <= 0 ||
      manifest.onnxRuntime.sha256 !== expected.onnxRuntimeSha256 ||
      manifest.onnxRuntime.size !== expected.onnxRuntimeSize ||
      manifest.onnxRuntime.license !== 'MIT' ||
      manifest.onnxRuntime.upstreamRevision !==
        expected.onnxRuntimeUpstreamRevision
    ) {
      return false;
    }
    const workerMetadata = lstatSync(
      resolve(root, manifest.files.mediaWorker.path),
    );
    if (
      expected.platform !== 'windows' &&
      (workerMetadata.mode & 0o111) === 0
    ) {
      return false;
    }
    if (
      !Array.isArray(manifest.legalFiles) ||
      manifest.legalFiles.length === 0
    ) {
      return false;
    }
    const declaredLegalPaths = manifest.legalFiles.map((entry) => entry.path);
    if (
      declaredLegalPaths.some(
        (path, index) =>
          !path.startsWith('legal/') ||
          declaredLegalPaths.indexOf(path) !== index ||
          !validIntegrityFile(root, manifest.legalFiles[index]),
      )
    ) {
      return false;
    }
    const actualLegalPaths = filesUnder(join(root, 'legal'))
      .map((path) => relative(root, path).replaceAll('\\', '/'))
      .sort();
    declaredLegalPaths.sort();
    if (
      JSON.stringify(declaredLegalPaths) !== JSON.stringify(actualLegalPaths)
    ) {
      return false;
    }
    const declaredBundlePaths = [
      'manifest.json',
      ...Object.values(manifest.files).map((entry) => entry.path),
      ...declaredLegalPaths,
    ].sort();
    const actualBundlePaths = filesUnder(root)
      .map((path) => relative(root, path).replaceAll('\\', '/'))
      .sort();
    if (
      JSON.stringify(declaredBundlePaths) !== JSON.stringify(actualBundlePaths)
    ) {
      return false;
    }
    for (const filename of REQUIRED_SPEECH_LEGAL_FILES) {
      const metadata = lstatSync(join(root, 'legal', filename));
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size === 0
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
