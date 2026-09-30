import { promises as fs } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = process.cwd();
const schema = JSON.parse(
  await fs.readFile(path.join(root, "srm_observations_schema.json"), "utf8"),
);
const observations = JSON.parse(
  await fs.readFile(
    path.join(root, "intelligence", "srm", "release-observations.example.json"),
    "utf8",
  ),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

if (!validate(observations)) {
  for (const error of validate.errors ?? []) {
    console.error(`${error.instancePath || "/"}: ${error.message}`);
  }
  process.exitCode = 1;
} else {
  console.log(`${observations.releases.length} SRM release observation(s) passed validation.`);
}
