import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { isLocalRequest } from "./local-request.mjs";

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function runBrowserOperation(root, scriptName, argumentsList, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(root, "tools", scriptName),
        ...argumentsList,
      ],
      {
        cwd: root,
        windowsHide: false,
      },
    );
    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(timeoutMessage));
    }, 11 * 60 * 1000);

    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(output.trim());
      } else {
        const errorMatch = errorOutput.match(/Error: ([^\r\n]+)/);
        reject(
          new Error(
            errorMatch?.[1] ||
              output.trim().split(/\r?\n/).at(-1) ||
              `SRM refresh exited with code ${code}.`,
          ),
        );
      }
    });
  });
}

export function srmCompanionPlugin() {
  let root;
  let browserOperationInProgress = false;

  return {
    name: "grounds-srm-companion",
    apply: "serve",
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://grounds.local");
        const isSrmRefresh =
          requestUrl.pathname === "/__grounds/srm-refresh";
        const isEv2ServiceGroups =
          requestUrl.pathname === "/__grounds/ev2-service-groups";
        if (!isSrmRefresh && !isEv2ServiceGroups) {
          next();
          return;
        }

        response.setHeader("Content-Type", "application/json");
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end(JSON.stringify({ error: "Method not allowed." }));
          return;
        }
        if (!isLocalRequest(request)) {
          response.statusCode = 403;
          response.end(JSON.stringify({ error: "Local Grounds origin required." }));
          return;
        }
        if (browserOperationInProgress) {
          response.statusCode = 409;
          response.end(
            JSON.stringify({
              error: "Another Grounds browser operation is already in progress.",
            }),
          );
          return;
        }

        browserOperationInProgress = true;
        try {
          const payload = await readJsonBody(request);
          if (
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              payload.serviceTreeId,
            )
          ) {
            throw new Error("The service does not have a valid Service Tree ID.");
          }

          if (isSrmRefresh) {
            const releaseUrl = new URL(payload.releaseUrl);
            const supportedSrmHosts = new Set([
              "srm.azure.com",
              "bridge.azure.com",
            ]);
            if (
              releaseUrl.protocol !== "https:" ||
              !supportedSrmHosts.has(releaseUrl.hostname) ||
              !releaseUrl.hash.startsWith("#/ReleaseStatus/Release/")
            ) {
              throw new Error("Enter a valid SRM release URL.");
            }
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.serviceName)) {
              throw new Error("Invalid service name.");
            }
            if (
              typeof payload.serviceGroupId !== "string" ||
              payload.serviceGroupId.length === 0
            ) {
              throw new Error("Select the EV2 service group for this release.");
            }
            await runBrowserOperation(
              root,
              "srm-browser-poc.mjs",
              [
                payload.releaseUrl,
                `--service-name=${payload.serviceName}`,
                `--service-tree-id=${payload.serviceTreeId}`,
                `--service-group-id=${payload.serviceGroupId}`,
              ],
              "The SRM browser session timed out after 11 minutes.",
            );
          } else {
            if (!["public", "ussec", "usnat"].includes(payload.cloud)) {
              throw new Error(
                "Service-group discovery supports Public, USSec, and USNat.",
              );
            }
            await runBrowserOperation(
              root,
              "ev2-service-groups-browser.mjs",
              [payload.serviceTreeId, payload.cloud],
              "The EV2 browser session timed out after 11 minutes.",
            );
          }

          response.end(JSON.stringify({ status: "completed" }));
          server.ws.send({ type: "full-reload" });
        } catch (error) {
          response.statusCode = 400;
          response.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        } finally {
          browserOperationInProgress = false;
        }
      });
    },
  };
}
