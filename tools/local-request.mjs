const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const loopbackAddresses = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

function readHostname(value) {
  if (!value) return undefined;
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

export function isLocalRequest(request) {
  const remoteAddress = request.socket.remoteAddress ?? "";
  if (!loopbackAddresses.has(remoteAddress)) return false;

  const host = readHostname(`http://${request.headers.host ?? ""}`);
  if (!host || !loopbackHostnames.has(host)) return false;

  const origin = request.headers.origin;
  if (!origin) return true;

  const originHost = readHostname(origin);
  return Boolean(originHost && loopbackHostnames.has(originHost));
}
