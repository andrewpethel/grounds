import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createServiceValidator,
  formatValidationErrors,
  listServiceFiles,
  toSourcePath,
  validateServiceFile,
} from "./service-validation.mjs";
import {
  analyzeRepositoryUrl,
  createServiceRecord,
} from "./service-onboarding.mjs";
import { isLocalRequest } from "./local-request.mjs";

const virtualModuleId = "virtual:service-catalog";
const resolvedVirtualModuleId = `\0${virtualModuleId}`;

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 250_000) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

export function serviceCatalogPlugin() {
  let root;
  let command;
  let validate;
  const acceptedRecords = new Map();
  const validationResults = new Map();

  async function validateFile(filePath) {
    const result = await validateServiceFile(root, filePath, validate);
    validationResults.set(result.sourcePath, result);

    if (result.status === "valid") {
      acceptedRecords.set(result.sourcePath, {
        record: result.record,
        sourceFilePath: path.resolve(filePath),
        sourcePath: result.sourcePath,
      });
    }

    return result;
  }

  async function initialize({ preserveAccepted = false } = {}) {
    validate = await createServiceValidator(root);
    const files = await listServiceFiles(root);

    if (!preserveAccepted) {
      acceptedRecords.clear();
    }
    validationResults.clear();

    const results = [];
    for (const filePath of files) {
      results.push(await validateFile(filePath));
    }

    return results;
  }

  function catalogModuleSource() {
    const catalogEntries = [...acceptedRecords.values()].sort((left, right) =>
      left.sourcePath.localeCompare(right.sourcePath),
    );
    const initialValidation = Object.fromEntries(
      [...validationResults.entries()].map(([sourcePath, result]) => [
        sourcePath,
        {
          checkedAt: result.checkedAt,
          errors: result.errors,
          sourcePath,
          status: result.status,
        },
      ]),
    );

    return [
      `export const catalogEntries = ${JSON.stringify(catalogEntries)};`,
      `export const initialValidation = ${JSON.stringify(initialValidation)};`,
    ].join("\n");
  }

  function invalidateCatalog(server, reload) {
    const module = server.moduleGraph.getModuleById(resolvedVirtualModuleId);
    if (module) server.moduleGraph.invalidateModule(module);
    if (reload) server.ws.send({ type: "full-reload" });
  }

  function configureValidationMiddleware(server) {
    server.middlewares.use("/__grounds/service-validation", (request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://grounds.local");
      const sourcePath = requestUrl.searchParams.get("sourcePath");
      const result = sourcePath ? validationResults.get(sourcePath) : undefined;

      response.setHeader("Content-Type", "application/json");
      if (!sourcePath || !result) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "Unknown service source path." }));
        return;
      }

      response.end(
        JSON.stringify({
          checkedAt: result.checkedAt,
          errors: result.errors,
          sourcePath,
          status: result.status,
        }),
      );
    });
  }

  function configureOnboardingMiddleware(server) {
    server.middlewares.use(async (request, response, next) => {
      const requestUrl = new URL(request.url ?? "/", "http://grounds.local");
      if (!requestUrl.pathname.startsWith("/__grounds/service-onboarding/")) {
        next();
        return;
      }
      if (!isLocalRequest(request)) {
        sendJson(response, 403, { error: "Local Grounds origin required." });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "Method not allowed." });
        return;
      }

      try {
        const payload = await readJsonBody(request);
        if (requestUrl.pathname === "/__grounds/service-onboarding/analyze") {
          const analysis = await analyzeRepositoryUrl(payload.repositoryUrl);
          sendJson(response, 200, { analysis });
          return;
        }
        if (requestUrl.pathname === "/__grounds/service-onboarding/create") {
          const { domain, fileName, record } = createServiceRecord(payload);
          const duplicateRepository = [...acceptedRecords.values()].find(({ record: candidate }) =>
            candidate.repositories.some(
              (repository) =>
                repository.url.toLocaleLowerCase() ===
                record.repositories[0].url.toLocaleLowerCase(),
            ),
          );
          if (duplicateRepository) {
            sendJson(response, 409, {
              error: `Repository is already cataloged in ${duplicateRepository.sourcePath}.`,
            });
            return;
          }

          const valid = validate(record);
          if (!valid) {
            sendJson(response, 400, {
              error: "Generated service record failed schema validation.",
              errors: validate.errors ?? [],
            });
            return;
          }

          const directory = path.join(root, "services", domain);
          const filePath = path.join(directory, fileName);
          await fs.mkdir(directory, { recursive: true });
          try {
            await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, {
              encoding: "utf8",
              flag: "wx",
            });
          } catch (error) {
            if (error?.code === "EEXIST") {
              sendJson(response, 409, {
                error: `A service named ${record.service.name} already exists in ${domain}.`,
              });
              return;
            }
            throw error;
          }
          sendJson(response, 201, {
            serviceName: record.service.name,
            sourcePath: toSourcePath(root, filePath),
          });
          return;
        }
        sendJson(response, 404, { error: "Unknown onboarding operation." });
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  return {
    name: "grounds-service-catalog",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
      command = config.command;
    },
    async buildStart() {
      const results = await initialize();
      const invalidResults = results.filter((result) => result.status === "invalid");

      if (command === "build" && invalidResults.length > 0) {
        const details = invalidResults
          .map(
            (result) =>
              `${result.sourcePath}\n${formatValidationErrors(result)}`,
          )
          .join("\n\n");
        this.error(
          `${invalidResults.length} service record(s) failed service_schema.json validation:\n\n${details}`,
        );
      }
    },
    resolveId(id) {
      return id === virtualModuleId ? resolvedVirtualModuleId : undefined;
    },
    load(id) {
      return id === resolvedVirtualModuleId ? catalogModuleSource() : undefined;
    },
    async configureServer(server) {
      await initialize();
      configureValidationMiddleware(server);
      configureOnboardingMiddleware(server);

      const servicesRoot = path.join(root, "services");
      const schemaPath = path.join(root, "service_schema.json");
      server.watcher.add([servicesRoot, schemaPath]);

      async function handleServiceChange(filePath) {
        if (!filePath.endsWith(".json") || !filePath.startsWith(servicesRoot)) {
          return;
        }

        const result = await validateFile(filePath);
        server.ws.send({
          type: "custom",
          event: "grounds:service-validation",
          data: {
            checkedAt: result.checkedAt,
            errors: result.errors,
            sourcePath: result.sourcePath,
            status: result.status,
          },
        });
        invalidateCatalog(server, result.status === "valid");
      }

      server.watcher.on("add", handleServiceChange);
      server.watcher.on("change", async (filePath) => {
        if (path.resolve(filePath) === path.resolve(schemaPath)) {
          await initialize({ preserveAccepted: true });
          invalidateCatalog(server, true);
          return;
        }
        await handleServiceChange(filePath);
      });
      server.watcher.on("unlink", (filePath) => {
        if (!filePath.endsWith(".json") || !filePath.startsWith(servicesRoot)) {
          return;
        }
        const sourcePath = toSourcePath(root, filePath);
        acceptedRecords.delete(sourcePath);
        validationResults.delete(sourcePath);
        invalidateCatalog(server, true);
      });
    },
    async configurePreviewServer(server) {
      await initialize();
      configureValidationMiddleware(server);
    },
  };
}
