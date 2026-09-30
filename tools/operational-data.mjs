import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

export function examplePathFor(filePath) {
  const extension = path.extname(filePath);
  return `${filePath.slice(0, -extension.length)}.example${extension}`;
}

export function resolveOperationalDataPath(filePath) {
  return existsSync(filePath) ? filePath : examplePathFor(filePath);
}

export async function readOperationalJson(filePath) {
  const sourcePath = resolveOperationalDataPath(filePath);
  return JSON.parse(await fs.readFile(sourcePath, "utf8"));
}
