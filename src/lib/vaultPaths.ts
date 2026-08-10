/**
 * Mirrors `sanitize_name` in src-tauri/src/vault.rs so the folder preview in
 * the new-task modal shows the name that will actually be created.
 */
export function sanitizeFolderName(name: string): string {
  const cleaned = name
    .split("")
    .map((c) => ("\\/:*?\"<>|#^".includes(c) ? "-" : c.charCodeAt(0) < 0x20 ? " " : c))
    .join("")
    .trim()
    .replace(/\.+$/, "")
    .trim();
  return cleaned;
}
