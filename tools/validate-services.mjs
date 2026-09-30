import path from "node:path";
import {
  createServiceValidator,
  formatValidationErrors,
  listServiceFiles,
  validateServiceFile,
} from "./service-validation.mjs";

const root = process.cwd();
const validate = await createServiceValidator(root);
const files = await listServiceFiles(root);
const results = await Promise.all(
  files.map((filePath) => validateServiceFile(root, filePath, validate)),
);
const invalidResults = results.filter((result) => result.status === "invalid");

if (invalidResults.length > 0) {
  for (const result of invalidResults) {
    console.error(`\n${result.sourcePath}\n${formatValidationErrors(result)}`);
  }

  console.error(
    `\n${invalidResults.length} of ${results.length} service records failed validation.`,
  );
  process.exitCode = 1;
} else {
  console.log(`${results.length} service records passed service_schema.json validation.`);
}
