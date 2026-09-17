/** Shared DOM anchor policy for transcript, ToC, and server-side source locators. */
export function anchorId(prefix: string, id: unknown): string {
  const cleanId = String(id || "").replace(/[^A-Za-z0-9_-]/g, "-");
  const normalizedPrefix = prefix.endsWith("-") ? prefix.slice(0, -1) : prefix;
  const alreadyHasPrefix = cleanId.toLowerCase().startsWith(normalizedPrefix.toLowerCase() + "-")
    || cleanId.toLowerCase().startsWith(normalizedPrefix.toLowerCase() + "_");
  return alreadyHasPrefix ? cleanId : `${normalizedPrefix}-${cleanId}`;
}
