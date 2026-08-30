import assert from 'node:assert/strict';
import test from 'node:test';
import {
  macSourceBuildPrerequisiteFailures,
  MINIMUM_MAC_SOURCE_CMAKE_VERSION,
  MINIMUM_MAC_SOURCE_PYTHON_VERSION,
  parseCmakeVersion,
  parsePythonVersion,
} from './document-processing-build-tools.mjs';

const completeTools = {
  gitVersion: 'git version 2.50.1',
  pythonVersion: 'Python 3.13.7',
  cmakeVersion: 'cmake version 3.28.0',
  appleClangPath: '/usr/bin/clang',
  appleClangPlusPlusPath: '/usr/bin/clang++',
};

test('macOS source build accepts the pinned minimum CMake version', () => {
  assert.equal(MINIMUM_MAC_SOURCE_CMAKE_VERSION, '3.28.0');
  assert.equal(MINIMUM_MAC_SOURCE_PYTHON_VERSION, '3.8.0');
  assert.deepEqual(parseCmakeVersion('cmake version 4.1.2\n'), [4, 1, 2]);
  assert.deepEqual(parsePythonVersion('Python 3.13.7\n'), [3, 13, 7]);
  assert.deepEqual(macSourceBuildPrerequisiteFailures(completeTools), []);
});

test('macOS source build reports every missing tool with recovery commands', () => {
  const failures = macSourceBuildPrerequisiteFailures({});
  assert.deepEqual(
    failures.map(({ name }) => name),
    ['Git', 'Python >= 3.8.0', 'CMake >= 3.28.0', 'Apple Clang'],
  );
  assert.ok(failures.every(({ install, verify }) => install && verify));
});

test('macOS source build rejects an old or unparseable CMake', () => {
  const old = macSourceBuildPrerequisiteFailures({
    ...completeTools,
    cmakeVersion: 'cmake version 3.27.9',
  });
  assert.match(old[0].reason, /found 3\.27\.9/);

  const unknown = macSourceBuildPrerequisiteFailures({
    ...completeTools,
    cmakeVersion: 'unexpected output',
  });
  assert.match(unknown[0].reason, /could not parse/);
});

test('macOS source build rejects an old or unparseable Python', () => {
  const old = macSourceBuildPrerequisiteFailures({
    ...completeTools,
    pythonVersion: 'Python 3.7.17',
  });
  assert.match(old[0].reason, /found 3\.7\.17/);

  const unknown = macSourceBuildPrerequisiteFailures({
    ...completeTools,
    pythonVersion: 'unexpected output',
  });
  assert.match(unknown[0].reason, /could not parse/);
});
