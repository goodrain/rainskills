"use strict";

const { classifyTool } = require("./tool-policy.js");
const STATUS_PATH = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,3}$/;

function plain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


function stringArray(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${label} must be a non-empty string array`);
  }
}

function validatePollInput(toolName, input) {
  if (classifyTool(toolName, input?.arguments) !== "read") throw new Error("poll accepts only a read-only tool");
  if (!plain(input) || !plain(input.arguments)) throw new Error("poll input and arguments must be objects");
  if (!STATUS_PATH.test(input.status_path || "") || input.status_path.includes("__proto__")) throw new Error("status_path is invalid");
  stringArray(input.terminal_values, "terminal_values");
  stringArray(input.failure_values, "failure_values");
  if (input.retryable_values !== undefined) stringArray(input.retryable_values, "retryable_values");
  if (!Number.isInteger(input.max_attempts) || input.max_attempts < 1 || input.max_attempts > 12) throw new Error("max_attempts must be between 1 and 12");
  if (!Number.isInteger(input.interval_ms) || input.interval_ms < 0 || input.interval_ms > 10_000) throw new Error("interval_ms is invalid");
  if (!Number.isInteger(input.timeout_ms) || input.timeout_ms < 1 || input.timeout_ms > 60_000) throw new Error("timeout_ms is invalid");
  return input;
}

async function withinBudget(action, milliseconds, signal) {
  const controller = new AbortController();
  let timer;
  let abort;
  const stopped = new Promise((_resolve, reject) => {
    abort = () => { controller.abort(); reject(new Error("cancelled")); };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, Math.max(1, milliseconds));
  });
  try {
    if (signal?.aborted) return await stopped;
    return await Promise.race([stopped, action(controller.signal)]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function valueAtPath(value, path) {
  let current = value;
  for (const segment of path.split(".")) {
    if (!plain(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function result({ transitions, attempts, unchanged, finalState, blocker, retryable, start, end }) {
  return {
    schema: "rainskills.protected-poll.v1",
    transitions,
    final_state: finalState,
    completed: blocker === null,
    blocker,
    retryable,
    attempts,
    unchanged_omitted: unchanged,
    elapsed_ms: Math.max(0, end - start),
  };
}

async function executeProtectedPoll(toolName, input, {
  callTool,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
  signal,
} = {}) {
  validatePollInput(toolName, input);
  if (typeof callTool !== "function") throw new Error("poll callTool is required");
  const start = now();
  const transitions = [];
  let previous;
  let attempts = 0;
  let unchanged = 0;
  for (; attempts < input.max_attempts; attempts += 1) {
    if (signal?.aborted) return result({ transitions, attempts, unchanged, finalState: previous ?? null, blocker: "cancelled", retryable: false, start, end: now() });
    const remaining = input.timeout_ms - (now() - start);
    if (remaining <= 0) return result({ transitions, attempts, unchanged, finalState: previous ?? null, blocker: "timeout", retryable: true, start, end: now() });
    let response;
    try {
      response = await withinBudget((requestSignal) => callTool(toolName, input.arguments, { timeoutMs: remaining, signal: requestSignal }), remaining, signal);
    } catch (error) {
      const blocker = signal?.aborted ? "cancelled" : ["timeout", "cancelled"].includes(error.message) ? error.message : "read-failed";
      return result({ transitions, attempts: attempts + 1, unchanged, finalState: previous ?? null, blocker, retryable: blocker !== "cancelled", start, end: now() });
    }
    const state = valueAtPath(response, input.status_path);
    if (typeof state !== "string" && typeof state !== "number" && typeof state !== "boolean") {
      return result({ transitions, attempts: attempts + 1, unchanged, finalState: previous ?? null, blocker: "status-unavailable", retryable: false, start, end: now() });
    }
    const normalized = String(state);
    if (normalized !== previous) {
      transitions.push({ state: normalized, attempt: attempts + 1 });
      previous = normalized;
    } else {
      unchanged += 1;
    }
    if (input.terminal_values.includes(normalized)) {
      const failed = input.failure_values.includes(normalized);
      return result({
        transitions,
        attempts: attempts + 1,
        unchanged,
        finalState: normalized,
        blocker: failed ? String(response.blocker || "terminal-failure") : null,
        retryable: failed && (input.retryable_values || []).includes(normalized),
        start,
        end: now(),
      });
    }
    if (attempts + 1 < input.max_attempts && input.interval_ms > 0) {
      const remainingSleep = input.timeout_ms - (now() - start);
      if (remainingSleep <= 0) return result({ transitions, attempts: attempts + 1, unchanged, finalState: previous ?? null, blocker: "timeout", retryable: true, start, end: now() });
      try { await withinBudget(() => sleep(Math.min(input.interval_ms, remainingSleep)), remainingSleep, signal); }
      catch { return result({ transitions, attempts: attempts + 1, unchanged, finalState: previous ?? null, blocker: signal?.aborted ? "cancelled" : "timeout", retryable: !signal?.aborted, start, end: now() }); }
    }
  }
  return result({ transitions, attempts, unchanged, finalState: previous ?? null, blocker: "attempt-budget-exhausted", retryable: true, start, end: now() });
}

module.exports = {
  executeProtectedPoll,
  validatePollInput,
};
