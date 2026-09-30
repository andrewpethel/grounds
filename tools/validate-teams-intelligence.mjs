import { promises as fs } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = process.cwd();
const schemaPath = path.join(root, "teams_intelligence_schema.json");
const snapshotPath = path.join(
  root,
  "intelligence",
  "teams",
  "deployment-signals.example.json",
);
const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });

addFormats(ajv);
const validate = ajv.compile(schema);

if (!validate(snapshot)) {
  for (const error of validate.errors ?? []) {
    console.error(
      `${error.instancePath || "/"}: ${error.message ?? "Validation failed"}`,
    );
  }
  process.exitCode = 1;
} else {
  console.log(
    `${snapshot.signals.length} Teams deployment intelligence signal(s) passed validation.`,
  );
}
