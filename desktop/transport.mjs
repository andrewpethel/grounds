import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";

const routes = [
  /^\/__grounds\/(?:service-validation|service-domain|local-repos|git-history|deployment-diffs|ado-work-items|srm-release-status|srm-refresh|ev2-service-groups)$/,
  /^\/__grounds\/service-onboarding\/(?:analyze|create)$/,
  /^\/__grounds\/work\/(?:notes(?:\/[^/]+)?|settings|ado-context|ado)$/,
  /^\/__grounds\/service-chat\/sessions(?:\/[^/]+(?:\/messages)?)?$/,
  /^\/__grounds\/service-chat\/copilot\/(?:status|login|cancel|logout)$/,
  /^\/__grounds\/service-chat\/architecture\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/cancel)?$/,
];

export function validateRequest(input) {
  if (!input || typeof input.path !== "string" || input.path.length > 8000 ||
      !input.path.startsWith("/__grounds/")) {
    throw new Error("Invalid Grounds request.");
  }
  const url = new URL(input.path, "http://127.0.0.1");
  if (url.origin !== "http://127.0.0.1" || !routes.some((route) => route.test(url.pathname))) {
    throw new Error("Grounds operation is not allowed.");
  }
  if (!["GET", "POST", "PUT", "DELETE"].includes(input.method)) {
    throw new Error("Grounds request method is not allowed.");
  }
  if (input.body !== undefined && (typeof input.body !== "string" || input.body.length > 250_000)) {
    throw new Error("Grounds request body is too large or invalid.");
  }
  return { path: `${url.pathname}${url.search}`, method: input.method, body: input.body };
}

// Exercise the existing Node middleware over an in-memory HTTP stream, never a listening socket.
export function dispatch(middlewares, input) {
  const operation = validateRequest(input);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1" });
    const request = new IncomingMessage(socket);
    request.complete = true;
    request.method = operation.method;
    request.url = operation.path;
    request.headers = {
      host: "127.0.0.1",
      origin: "http://127.0.0.1",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(operation.body ?? "")),
    };
    const response = new ServerResponse(request);
    socket.on("error", reject);
    socket.on("close", () => {
      if (!response.writableFinished) reject(new Error("Grounds operation closed before completing."));
    });
    response.useChunkedEncodingByDefault = false;
    response.shouldKeepAlive = false;
    response.assignSocket(socket);
    response.on("error", reject);
    request.on("error", reject);
    response.on("finish", () => {
      const wire = Buffer.concat(chunks);
      const boundary = wire.indexOf("\r\n\r\n");
      resolve({
        status: response.statusCode,
        body: wire.subarray(boundary + 4).toString("utf8"),
      });
      socket.destroy();
    });
    middlewares(request, response, (error) => {
      response.statusCode = error ? 500 : 404;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ error: error?.message ?? "Unknown Grounds operation." }));
    });
    request.push(operation.body ?? null);
    if (operation.body !== undefined) request.push(null);
  });
}
