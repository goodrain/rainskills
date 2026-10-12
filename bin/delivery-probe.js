"use strict";

const dns = require("node:dns").promises;
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");

const MAX_REDIRECTS = 3;
const CONNECT_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_URL_LENGTH = 4_096;
const POLICY_VERSION = "rainskills.delivery-probe-policy.v1";

function isPublicIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 192 && b === 0 && parts[2] === 2) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0 && parts[2] === 113) return false;
  return true;
}

function ipv6Parts(address) {
  let normalized = address.toLowerCase().split("%", 1)[0];
  const dotted = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null;
    const octets = dotted[1].split(".").map(Number);
    normalized = `${normalized.slice(0, -dotted[1].length)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const tokens = [...left, ...Array(missing).fill("0"), ...right];
  if (tokens.length !== 8 || tokens.some((token) => !/^[0-9a-f]{1,4}$/.test(token))) return null;
  return tokens.map((token) => Number.parseInt(token, 16));
}

function embeddedIpv4(parts, offset) {
  return [
    parts[offset] >> 8,
    parts[offset] & 0xff,
    parts[offset + 1] >> 8,
    parts[offset + 1] & 0xff,
  ].join(".");
}

function isPublicIpv6(address) {
  const parts = ipv6Parts(address);
  if (!parts) return false;
  if (parts.every((part) => part === 0)) return false;
  if (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) return false;
  if ((parts[0] & 0xfe00) === 0xfc00) return false;
  if ((parts[0] & 0xffc0) === 0xfe80) return false;
  if ((parts[0] & 0xff00) === 0xff00) return false;
  if (parts[0] === 0x0100 && parts.slice(1, 4).every((part) => part === 0)) return false;
  if (parts[0] === 0x2001 && parts[1] === 0x0000) return false;
  if (parts[0] === 0x2001 && (parts[1] & 0xfff0) === 0x0010) return false;
  if (parts[0] === 0x2001 && (parts[1] & 0xfff0) === 0x0020) return false;
  if (parts[0] === 0x2001 && parts[1] === 0x0002) return false;
  if (parts[0] === 0x2001 && parts[1] === 0x0db8) return false;
  if ((parts[0] & 0xfff0) === 0x3ff0) return false;
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
    return isPublicIpv4(embeddedIpv4(parts, 6));
  }
  if (parts.slice(0, 6).every((part) => part === 0)) {
    return isPublicIpv4(embeddedIpv4(parts, 6));
  }
  if (parts[0] === 0x0064 && parts[1] === 0xff9b && parts.slice(2, 6).every((part) => part === 0)) {
    return isPublicIpv4(embeddedIpv4(parts, 6));
  }
  if (parts[0] === 0x2002) return isPublicIpv4(embeddedIpv4(parts, 1));
  return true;
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function normalizedHostname(url) {
  return url.hostname.replace(/^\[|\]$/g, "");
}

async function defaultResolveHost(hostname) {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function defaultRequestUrl(url, {
  method,
  address,
  headers,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  totalTimeoutMs = TOTAL_TIMEOUT_MS,
  maxBodyBytes = MAX_BODY_BYTES,
}) {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    let settled = false;
    let connectTimer;
    let totalTimer;
    const finish = (result, request) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      if (request && !request.destroyed) request.destroy();
      resolve(result);
    };
    const request = client.request(url, {
      method,
      headers,
      redirect: "manual",
      lookup: (_hostname, options, callback) => {
        const family = net.isIP(address);
        if (options && options.all) {
          callback(null, [{ address, family }]);
          return;
        }
        callback(null, address, family);
      },
    }, (response) => {
      const statusCode = response.statusCode || 0;
      const location = response.headers.location;
      const contentType = String(response.headers["content-type"] || "");
      const contentLength = Number(response.headers["content-length"] || 0);
      if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
        response.resume();
        finish({ error: "body_too_large" }, request);
        return;
      }
      if (method === "HEAD" || (statusCode >= 300 && statusCode < 400)) {
        response.resume();
        finish({ statusCode, location, contentType, bodyBytes: 0 }, request);
        return;
      }
      let bodyBytes = 0;
      response.on("data", (chunk) => {
        bodyBytes += chunk.length;
        if (bodyBytes > maxBodyBytes) finish({ error: "body_too_large" }, request);
      });
      response.on("end", () => finish({ statusCode, location, contentType, bodyBytes }, request));
      response.on("error", () => finish({ error: "response_error" }, request));
    });
    request.on("socket", (socket) => {
      if (!socket.connecting) return;
      connectTimer = setTimeout(() => finish({ error: "timeout" }, request), connectTimeoutMs);
      socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
    });
    request.on("error", (error) => finish({ error: error.code === "ETIMEDOUT" ? "timeout" : "request_error" }, request));
    totalTimer = setTimeout(() => finish({ error: "timeout" }, request), totalTimeoutMs);
    request.end();
  });
}

function parseTarget(value) {
  if (typeof value !== "string" || !value || value.length > MAX_URL_LENGTH) return null;
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  return url;
}

function createDeliveryProbe({
  resolveHost = defaultResolveHost,
  requestUrl = defaultRequestUrl,
} = {}) {
  return async function probe(input) {
    const allowedInputKeys = new Set(["policy_version", "url", "method"]);
    const validShape = input && typeof input === "object" && !Array.isArray(input)
      && Object.keys(input).every((key) => allowedInputKeys.has(key));
    const method = input?.method;
    let current = parseTarget(input?.url);
    const candidateUrl = current ? current.href : String(input?.url || "");
    if (!validShape || !current || !["HEAD", "GET"].includes(method) || input?.policy_version !== POLICY_VERSION) {
      return { policy_version: POLICY_VERSION, status: "rejected", reason: "unsafe_url_or_method", candidate_url: candidateUrl };
    }
    const redirects = [];
    let prefetchedResolution = null;

    const resolveSafeAddresses = async (url) => {
      const hostname = normalizedHostname(url);
      try {
        const addresses = net.isIP(hostname) ? [hostname] : await resolveHost(hostname);
        if (!Array.isArray(addresses) || !addresses.length || addresses.some((address) => !isPublicAddress(address))) {
          return { error: "non_public_address" };
        }
        return { addresses };
      } catch (_error) {
        return { error: "dns_error" };
      }
    };

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const resolved = prefetchedResolution || await resolveSafeAddresses(current);
      prefetchedResolution = null;
      if (resolved.error) {
        return {
          policy_version: POLICY_VERSION,
          status: resolved.error === "dns_error" ? "failed" : "rejected",
          reason: resolved.error,
          candidate_url: candidateUrl,
        };
      }

      const headers = Object.freeze({ Accept: "*/*", "User-Agent": "rainskills-delivery-probe/1" });
      const response = await requestUrl(current, {
        method,
        address: resolved.addresses[0],
        headers,
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
        totalTimeoutMs: TOTAL_TIMEOUT_MS,
        maxBodyBytes: MAX_BODY_BYTES,
      });
      if (response?.error) {
        return { policy_version: POLICY_VERSION, status: "failed", reason: response.error, candidate_url: candidateUrl };
      }

      const statusCode = Number(response?.statusCode || 0);
      if (statusCode >= 300 && statusCode < 400) {
        if (!response.location) {
          return { policy_version: POLICY_VERSION, status: "failed", reason: "redirect_without_location", candidate_url: candidateUrl };
        }
        if (redirectCount === MAX_REDIRECTS) {
          return { policy_version: POLICY_VERSION, status: "failed", reason: "too_many_redirects", candidate_url: candidateUrl };
        }
        let next;
        try {
          next = parseTarget(new URL(response.location, current).href);
        } catch (_error) {
          next = null;
        }
        if (!next) return { policy_version: POLICY_VERSION, status: "rejected", reason: "unsafe_redirect", candidate_url: candidateUrl };
        const nextResolved = await resolveSafeAddresses(next);
        if (nextResolved.error) {
          return { policy_version: POLICY_VERSION, status: "rejected", reason: "unsafe_redirect", candidate_url: candidateUrl };
        }
        if (current.protocol === "https:" && next.protocol !== "https:") {
          return { policy_version: POLICY_VERSION, status: "rejected", reason: "redirect_downgrade", candidate_url: candidateUrl };
        }
        const sameEndpoint = next.host === current.host && next.protocol === current.protocol;
        const httpUpgrade = current.protocol === "http:"
          && next.protocol === "https:"
          && normalizedHostname(next) === normalizedHostname(current)
          && (current.port || "80") === "80"
          && (next.port || "443") === "443";
        if (!sameEndpoint && !httpUpgrade) {
          return {
            policy_version: POLICY_VERSION,
            status: "manual_validation_required",
            reason: "cross_host_redirect",
            candidate_url: candidateUrl,
            redirect_target: next.href,
          };
        }
        redirects.push(next.href);
        current = next;
        prefetchedResolution = nextResolved;
        continue;
      }

      return {
        policy_version: POLICY_VERSION,
        status: statusCode >= 200 && statusCode < 400 ? "verified" : "failed",
        reason: statusCode >= 200 && statusCode < 400 ? null : "http_status",
        candidate_url: candidateUrl,
        final_url: current.href,
        status_code: statusCode,
        content_type: String(response.contentType || ""),
        body_bytes: Number(response.bodyBytes || 0),
        redirects,
      };
    }
    return { policy_version: POLICY_VERSION, status: "failed", reason: "too_many_redirects", candidate_url: candidateUrl };
  };
}

module.exports = {
  CONNECT_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
  TOTAL_TIMEOUT_MS,
  POLICY_VERSION,
  createDeliveryProbe,
  defaultRequestUrl,
  isPublicAddress,
};
