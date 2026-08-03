"use strict";

const os = require("node:os");

function validatedDistroName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) return "";
  return name;
}

function detectControlEnvironment({
  platform = process.platform,
  env = process.env,
  kernelRelease = os.release(),
} = {}) {
  if (platform === "win32") {
    return {
      mode: "windows-native",
      hostPlatform: "win32",
      controlPlatform: "win32",
    };
  }

  const isWslKernel = platform === "linux" && /(?:microsoft|wsl)/iu.test(String(kernelRelease));
  const hasWslMarker = Boolean(
    (typeof env.WSL_INTEROP === "string" && env.WSL_INTEROP.trim())
    || (typeof env.WSL_DISTRO_NAME === "string" && env.WSL_DISTRO_NAME.trim())
  );

  if (isWslKernel && hasWslMarker) {
    const control = {
      mode: "wsl",
      hostPlatform: "win32",
      controlPlatform: "linux",
    };
    const controlDistro = validatedDistroName(env.WSL_DISTRO_NAME);
    if (controlDistro) control.controlDistro = controlDistro;
    return control;
  }

  return {
    mode: "posix",
    hostPlatform: platform,
    controlPlatform: platform,
  };
}

module.exports = { detectControlEnvironment };
