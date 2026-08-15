"use strict";

const path = require("node:path");

const { createSecureStateStore } = require(path.resolve(
  __dirname,
  "..",
  "..",
  "rainbond-platform-installer",
  "scripts",
  "secure-state.js"
));

const TEST_WINDOWS_SID = "S-1-5-21-111-222-333-1001";

function createPortableSecureStateStore(home, options = {}) {
  if (process.platform !== "win32") {
    return createSecureStateStore({ ...options, platform: "linux", home });
  }

  const currentSid = options.currentSid || TEST_WINDOWS_SID;
  return createSecureStateStore({
    ...options,
    platform: "win32",
    home,
    currentSid,
    hardenWindowsAcl() {},
    inspectWindowsAcl() {
      return {
        ownerSid: currentSid,
        writableSids: [currentSid, "S-1-5-18", "S-1-5-32-544"],
        readableSids: [currentSid, "S-1-5-18", "S-1-5-32-544"],
        reparsePoint: false,
      };
    },
  });
}

module.exports = { createPortableSecureStateStore };
