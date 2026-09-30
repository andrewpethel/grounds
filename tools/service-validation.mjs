import { promises as fs } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export function toSourcePath(root, filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, "/");
}

export async function listServiceFiles(root) {
  const servicesRoot = path.join(root, "services");
  const entries = await fs.readdir(servicesRoot, {
    recursive: true,
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

export async function createServiceValidator(root) {
  const schemaPath = path.join(root, "service_schema.json");
  const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
  const ajv = new Ajv2020({
    allErrors: true,
    allowUnionTypes: true,
    strict: true,
  });

  addFormats(ajv);
  return ajv.compile(schema);
}

export async function validateServiceFile(root, filePath, validate) {
  const sourcePath = toSourcePath(root, filePath);

  try {
    const record = JSON.parse(await fs.readFile(filePath, "utf8"));
    const valid = validate(record);

    return {
      checkedAt: new Date().toISOString(),
      errors: valid
        ? []
        : (validate.errors ?? []).map((error) => ({
            instancePath: error.instancePath || "/",
            keyword: error.keyword,
            message: error.message ?? "Schema validation failed",
            params: error.params,
          })),
      record,
      sourcePath,
      status: valid ? "valid" : "invalid",
    };
  } catch (error) {
    return {
      checkedAt: new Date().toISOString(),
      errors: [
        {
          instancePath: "/",
          keyword: "parse",
          message: error instanceof Error ? error.message : String(error),
          params: {},
        },
      ],
      sourcePath,
      status: "invalid",
    };
  }
}

export function formatValidationErrors(result) {
  return result.errors
    .map((error) => `  ${error.instancePath}: ${error.message}`)
    .join("\n");
}
