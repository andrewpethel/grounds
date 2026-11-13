import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getNodeValue, parseTree, printParseErrorCode } from "jsonc-parser";
import { parseDocument } from "yaml";

export const serviceTreeIdPattern = /^(?!00000000-0000-0000-0000-000000000000$)(?!ffffffff-ffff-ffff-ffff-ffffffffffff$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const exec = promisify(execFile);
const normalize = (key) => key.replace(/[-_]/g, "").toLowerCase();
const excludedDirectories = /(?:^|\/)(?:\.git|node_modules|bin|obj|dist|coverage|test|tests|__tests__|fixtures|samples|examples|docs)(?:\/|$)/i;
const dependencyFields = new Set(["dependencies", "devdependencies", "references", "upstream", "downstream"]);
const maximumFiles = 2000;
const maximumFileBytes = 1_000_000;
const maximumTotalBytes = 10_000_000;

function property(value, name) {
  return value && typeof value === "object"
    ? Object.entries(value).find(([key]) => normalize(key) === name)
    : undefined;
}

function serviceName(value, fields) {
  for (const field of fields) {
    const entry = property(value, field);
    if (typeof entry?.[1] === "string" && entry[1].trim() && entry[1].trim().length <= 150) return [entry[0], entry[1].trim()];
  }
}

function filePriority(file) {
  const name = file.split("/").at(-1);
  return /^service[._-]?spec(?:ification)?(?:[._-].*)?\.(?:jsonc?|ya?ml)$/i.test(name) ? 0
    : /^service[._-]?model(?:[._-].*)?\.(?:jsonc?|ya?ml)$/i.test(name) ? 1 : 2;
}

function collect(value, file, segments, candidates, diagnostics, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalize(key);
    if (dependencyFields.has(normalized)) continue;
    const field = [...segments, key];
    const isExplicitId = normalized === "servicetreeid" || normalized === "servicetreeguid" ||
      (normalized === "id" && normalize(segments.at(-1) ?? "") === "servicetree");
    const isEv2Id = normalized === "serviceidentifier" && segments.length === 1 &&
      normalize(segments[0]) === "servicemetadata";
    const isServiceSpecId = normalized === "identifier" && segments.length === 0 &&
      String(property(value, "providertype")?.[1] ?? "").trim().toLowerCase() === "servicetree";
    if (isExplicitId || isEv2Id || isServiceSpecId) {
      const pointer = `/${field.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
      if (typeof child !== "string" || !serviceTreeIdPattern.test(child.trim())) {
        diagnostics.push(`${file} ${pointer}: Service Tree value is not a literal GUID; review manually.`);
      } else {
        const serviceTreeId = child.trim().toLowerCase();
        let candidate = candidates.get(serviceTreeId);
        if (!candidate) {
          candidate = { serviceTreeId, evidence: [] };
          candidates.set(serviceTreeId, candidate);
        }
        const nameFields = isServiceSpecId ? ["displayname", "servicename", "name", "description"]
          : isEv2Id ? ["displayname"]
            : normalize(segments.at(-1) ?? "") === "servicetree" ? ["displayname", "servicename", "name"] : ["displayname", "servicename"];
        const name = serviceName(value, nameFields);
        if (!name && nameFields.some((field) => {
          const text = property(value, field)?.[1];
          return typeof text === "string" && text.trim().length > 150;
        })) diagnostics.push(`${file}: service-name metadata exceeds the 150-character suggestion limit; enter the service name manually.`);
        candidate.evidence.push({
          file, field: pointer, kind: isServiceSpecId ? "service-spec" : isEv2Id ? "service-model" : "explicit",
          ...(name ? {
            displayName: name[1],
            displayNameField: `/${[...segments, name[0]].map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`,
          } : {}),
        });
      }
    } else {
      collect(child, file, field, candidates, diagnostics, seen);
    }
  }
}

function hasDuplicateKeys(node) {
  if (!node) return false;
  if (node.type === "object") {
    const names = node.children.map((property) => property.children[0].value);
    if (new Set(names).size !== names.length) return true;
  }
  return node.children?.some(hasDuplicateKeys) ?? false;
}

export async function scanRepositoryConfig(root, onProgress = () => {}) {
  const { stdout } = await exec("git", [
    "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard",
    "--", "*.json", "*.jsonc", "*.yaml", "*.yml",
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 8_000_000 });
  const files = [...new Set(stdout.split("\0").filter(Boolean))]
    .filter((file) => !excludedDirectories.test(file) && !/\.(?:example|test)\.(?:jsonc?|ya?ml)$/i.test(file))
    .sort((left, right) => filePriority(left) - filePriority(right) || left.localeCompare(right));
  const diagnostics = [];
  const candidates = new Map();
  const fingerprint = createHash("sha256");
  let bytesRead = 0;
  let scannedFiles = 0;
  if (files.length > maximumFiles) diagnostics.push(`Configuration scan limited to ${maximumFiles} files. Additional mappings may be missing.`);
  for (const file of files.slice(0, maximumFiles)) {
    const filePath = path.resolve(root, file);
    const relative = path.relative(root, filePath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Configuration path escapes the repository.");
    const metadata = await fs.lstat(filePath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      diagnostics.push(`${file}: tracked configuration is missing from this checkout; review manually.`);
      fingerprint.update(`${file}\0missing\0`);
      return null;
    });
    if (!metadata) continue;
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      diagnostics.push(`${file}: skipped because it is not a regular configuration file.`);
      fingerprint.update(`${file}\0skipped\0`);
      continue;
    }
    const realPath = await fs.realpath(filePath);
    const realRelative = path.relative(root, realPath);
    if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      diagnostics.push(`${file}: skipped because it resolves outside the repository.`);
      fingerprint.update(`${file}\0external\0`);
      continue;
    }
    if (metadata.size > maximumFileBytes) {
      diagnostics.push(`${file}: skipped because it exceeds the 1 MB configuration limit.`);
      fingerprint.update(`${file}\0oversize\0${metadata.size}\0${metadata.mtimeMs}\0`);
      continue;
    }
    if (bytesRead + metadata.size > maximumTotalBytes) {
      diagnostics.push("Configuration scan reached its 10 MB limit. Additional mappings may be missing.");
      break;
    }
    const content = await fs.readFile(realPath, "utf8");
    bytesRead += Buffer.byteLength(content);
    scannedFiles++;
    fingerprint.update(`${file}\0${content}\0`);
    if (scannedFiles === 1 || scannedFiles % 20 === 0 || scannedFiles === Math.min(files.length, maximumFiles)) {
      onProgress({ scannedFiles, totalFiles: Math.min(files.length, maximumFiles) });
    }
    let value;
    if (/\.ya?ml$/i.test(file)) {
      const document = parseDocument(content, { uniqueKeys: true });
      if (document.errors.length || document.warnings.length) {
        diagnostics.push(`${file}: YAML parsing failed or contains unsupported syntax; review manually.`);
        continue;
      }
      try {
        value = document.toJS({ maxAliasCount: 20 });
      } catch {
        diagnostics.push(`${file}: YAML aliases exceed the supported limit; review manually.`);
        continue;
      }
    } else {
      const errors = [];
      const tree = parseTree(content, errors, { allowTrailingComma: true, disallowComments: false });
      if (errors.length) {
        diagnostics.push(`${file}: JSON parsing failed (${printParseErrorCode(errors[0].error)}); review manually.`);
        continue;
      }
      if (hasDuplicateKeys(tree)) {
        diagnostics.push(`${file}: duplicate JSON keys make this configuration ambiguous; review manually.`);
        continue;
      }
      value = tree ? getNodeValue(tree) : undefined;
    }
    const provider = property(value, "providertype")?.[1];
    if (filePriority(file) === 0 && String(provider ?? "").trim().toLowerCase() !== "servicetree") {
      diagnostics.push(`${file}: ServiceSpec providerType is not ServiceTree; its generic identifier is not used as a Service Tree ID.`);
    } else if (String(provider ?? "").trim().toLowerCase() === "servicetree" && !property(value, "identifier")) {
      diagnostics.push(`${file}: Service Tree specification is missing its identifier; review manually.`);
    }
    collect(value, file, [], candidates, diagnostics);
  }
  const matches = [...candidates.values()].sort((left, right) => left.serviceTreeId.localeCompare(right.serviceTreeId));
  return {
    candidates: matches, diagnostics, scannedFiles,
    status: diagnostics.length ? "review" : matches.length === 1 ? "matched" : matches.length ? "multiple" : "missing",
    fingerprint: fingerprint.digest("hex"),
  };
}
