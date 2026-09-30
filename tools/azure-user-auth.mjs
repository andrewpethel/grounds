import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function azureCliCommand() {
  if (process.platform !== "win32") return "az";

  return (
    [
      process.env["ProgramFiles(x86)"],
      process.env.PROGRAMFILES,
      "C:\\Program Files (x86)",
    ]
      .filter(Boolean)
      .map((root) =>
        path.join(
          root,
          "Microsoft",
          "SDKs",
          "Azure",
          "CLI2",
          "wbin",
          "az.cmd",
        ),
      )
      .find((candidate) => existsSync(candidate)) ?? "az.cmd"
  );
}

export function getAzureCliToken(resource) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      azureCliCommand(),
      [
        "account",
        "get-access-token",
        "--resource",
        resource,
        "--query",
        "accessToken",
        "--output",
        "tsv",
      ],
      {
        shell: process.platform === "win32",
        windowsHide: true,
      },
    );
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
