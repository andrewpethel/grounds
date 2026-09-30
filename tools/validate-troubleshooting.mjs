import { promises as fs } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = process.cwd();
const schema = JSON.parse(
  await fs.readFile(path.join(root, "troubleshooting_schema.json"), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const troubleshootingRoot = path.join(root, "troubleshooting");
const entries = await fs.readdir(troubleshootingRoot, {
  recursive: true,
  withFileTypes: true,
});
const files = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
  .map((entry) => path.join(entry.parentPath, entry.name))
  .sort();
let invalid = 0;

for (const file of files) {
  try {
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    if (!validate(record)) {
      invalid += 1;
      console.error(`\n${path.relative(root, file)}`);
      for (const error of validate.errors ?? []) {
        console.error(`  ${error.instancePath || "/"}: ${error.message}`);
      }
    }
  } catch (error) {
    invalid += 1;
    console.error(`\n${path.relative(root, file)}\n  ${error.message}`);
  }
}

if (invalid > 0) {
  console.error(`\n${invalid} of ${files.length} troubleshooting records failed validation.`);
  process.exitCode = 1;
} else {
  console.log(`${files.length} troubleshooting record(s) passed troubleshooting_schema.json validation.`);
}
