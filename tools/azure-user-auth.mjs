import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export function azureCliInvocation(argumentsList) {
  if (process.platform !== "win32") {
    return { command: "az", args: argumentsList, options: { windowsHide: true, shell: false } };
  }
  const launchers = [
    process.env["ProgramFiles(x86)"],
    process.env.PROGRAMFILES,
    "C:\\Program Files (x86)",
    "C:\\Program Files",
  ]
    .filter(Boolean)
    .map((root) => path.join(root, "Microsoft", "SDKs", "Azure", "CLI2", "wbin", "az.cmd"));
  launchers.push(...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory.replace(/^"|"$/g, ""), "az.cmd")));
  const python = launchers.filter((launcher) => existsSync(launcher))
    .map((launcher) => path.resolve(path.dirname(launcher), "..", "python.exe"))
    .find((candidate) => existsSync(candidate));
  if (!python) throw new Error("Azure CLI's bundled Python executable was not found. Install or repair Azure CLI and run az login.");
  return {
    command: python, args: ["-IBm", "azure.cli", ...argumentsList],
    options: { windowsHide: true, shell: false, env: { ...process.env, AZ_INSTALLER: "MSI" } },
  };
}

export function getAzureCliToken(resource, { signal } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const invocation = azureCliInvocation([
      "account",
      "get-access-token",
      "--resource",
      resource,
      "--query",
      "accessToken",
      "--output",
      "tsv",
    ]);
    const child = spawn(invocation.command, invocation.args, { ...invocation.options, signal });
    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Azure CLI authentication timed out."));
    }, 60_000);

    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(
        new Error(
          error.code === "ENOENT"
            ? "Azure CLI is not installed. Install it and run az login."
            : error.message,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const token = output.trim();
      if (code === 0 && token) {
        resolve(token);
        return;
      }
      reject(
        new Error(
          errorOutput.trim() ||
            "Azure CLI could not acquire an access token. Run az login and try again.",
        ),
      );
    });
  });
}

export async function fetchAuthenticatedJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result?.message ?? result?.error ?? `${response.status} ${response.statusText}`);
  }
  return result;
}
