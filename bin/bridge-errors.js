"use strict";

const EXIT = Object.freeze({ USAGE: 2, CONFIG: 3, TRANSPORT: 4, TOOL: 5 });
class BridgeError extends Error {
  constructor(message, exitCode, payload, code) {
    super(message);
    this.exitCode = exitCode;
    this.payload = payload;
    this.code = code;
  }
}
function inputValidation(action) {
  try { return action(); } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError("input validation failed; check the command schema", EXIT.USAGE, undefined, "E_INPUT_INVALID");
  }
}
function errorResult(error) {
  const code = error.code || ({ 2: "E_INPUT_INVALID", 3: "E_CONFIGURATION", 4: "E_TRANSPORT", 5: "E_PLATFORM" })[error.exitCode] || "E_INTERNAL";
  return {
    ...(error.payload || { error: error.message }), code,
    stage: code === "E_RUNTIME_INCOMPLETE" ? "local" : error.exitCode === EXIT.USAGE ? "input" : error.exitCode === EXIT.CONFIG ? "configuration" : "request",
    next_action: code === "E_RUNTIME_INCOMPLETE" ? "repair_runtime" : error.exitCode === EXIT.USAGE ? "correct_input" : code === "E_WRITE_RESULT_UNKNOWN" ? "query_state" : "inspect_error",
  };
}
module.exports = { BridgeError, EXIT, inputValidation, errorResult };
