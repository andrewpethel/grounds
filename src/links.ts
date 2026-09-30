export function vscodeFileUri(path: string) {
  const normalizedPath = path.replaceAll("\\", "/");
  return `vscode://file/${encodeURI(normalizedPath)
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")}?windowId=_blank`;
}
