import { promises as fs } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = process.cwd();
const schema = JSON.parse(
  await fs.readFile(path.join(root, "ev2_service_groups_schema.json"), "utf8"),
);
const serviceGroups = JSON.parse(
  await fs.readFile(
    path.join(root, "intelligence", "ev2", "service-groups.example.json"),
    "utf8",
  ),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

if (!validate(serviceGroups)) {
  for (const error of validate.errors ?? []) {
    console.error(`${error.instancePath || "/"}: ${error.message}`);
  }
  process.exitCode = 1;
} else {
  const groupCount = serviceGroups.observations.reduce(
    (total, observation) => total + observation.serviceGroups.length,
    0,
  );
  console.log(
    `${serviceGroups.observations.length} EV2 observation(s) containing ${groupCount} service group(s) passed validation.`,
  );
}
