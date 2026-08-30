import { spawn } from "node:child_process";

function delay(milliseconds) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, milliseconds);
    timer.unref?.();
  });
}

export function spawnSpeechQualityProcess(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const completion = new Promise((resolvePromise) => {
    child.once("error", (error) => resolvePromise({ error }));
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  return { child, completion };
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function completionSettled(completion) {
  return Promise.race([
    completion.then(() => true),
    new Promise((resolvePromise) => {
      setImmediate(() => resolvePromise(false));
    }),
  ]);
}

async function waitForPosixTreeExit(contained, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      !processGroupExists(contained.child.pid) &&
      (await completionSettled(contained.completion))
    ) {
      return true;
    }
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return (
    !processGroupExists(contained.child.pid) &&
    (await completionSettled(contained.completion))
  );
}

async function runTaskkill(pid, timeoutMs) {
  const taskkill = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
    stdio: "ignore",
    windowsHide: true,
  });
  let timeout;
  try {
    const result = await Promise.race([
      new Promise((resolvePromise) => {
        taskkill.once("error", (error) => resolvePromise({ error }));
        taskkill.once("close", (code) => resolvePromise({ code }));
      }),
      new Promise((resolvePromise) => {
        timeout = setTimeout(
          () => resolvePromise({ timeout: true }),
          timeoutMs,
        );
      }),
    ]);
    if (result.timeout) taskkill.kill("SIGKILL");
    return !result.error && !result.timeout && result.code === 0;
  } finally {
    clearTimeout(timeout);
  }
}

export async function terminateSpeechQualityProcessTree(
  contained,
  { graceMs, label },
) {
  const pid = contained.child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    const outcome = await contained.completion;
    if (outcome.error) throw outcome.error;
    return;
  }

  if (process.platform === "win32") {
    if (!(await runTaskkill(pid, graceMs * 2))) {
      throw new Error(`${label} process tree could not be terminated`);
    }
    const outcome = await Promise.race([
      contained.completion,
      delay(graceMs).then(() => ({ timeout: true })),
    ]);
    if (outcome.timeout) {
      throw new Error(`${label} process tree did not settle after taskkill`);
    }
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  if (await waitForPosixTreeExit(contained, graceMs)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  if (!(await waitForPosixTreeExit(contained, graceMs))) {
    throw new Error(`${label} process tree did not exit after SIGKILL`);
  }
}

export async function waitForSpeechQualityProcess(
  contained,
  { timeoutMs, graceMs, label, abortPromise },
) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  let outcome;
  let primaryError;
  try {
    outcome = await Promise.race([
      contained.completion,
      deadline,
      ...(abortPromise ? [abortPromise] : []),
    ]);
    if (outcome.error) throw outcome.error;
  } catch (error) {
    primaryError = error;
  }
  clearTimeout(timeout);

  if (primaryError) {
    try {
      await terminateSpeechQualityProcessTree(contained, { graceMs, label });
    } catch (cleanupError) {
      if (primaryError instanceof Error) {
        primaryError.message = `${primaryError.message}; cleanup failed: ${cleanupError.message}`;
      }
    }
    throw primaryError;
  }
  return outcome;
}
