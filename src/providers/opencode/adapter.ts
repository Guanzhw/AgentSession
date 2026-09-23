import { getConfig } from "../../config.js";
import type { ProviderAdapter } from "../interface.js";
import v1 from "./v1-adapter.js";
import { createOpenCodeV2Adapter } from "./v2-adapter.js";
import { inspectOpenCodeStorage, openCodeStorageRevision, type OpenCodeStorage } from "./storage.js";

const dataPath = () => getConfig().dbPath as string;
const v2 = createOpenCodeV2Adapter(dataPath);
let cached: { revision: string; storage: OpenCodeStorage } | undefined;
function storage() {
  const revision = openCodeStorageRevision(dataPath());
  if (cached?.revision !== revision) cached = { revision, storage: inspectOpenCodeStorage(dataPath()) };
  return cached.storage;
}

// Optional methods and capabilities must come from the selected reader too:
// exposing v1 structured accessors on v2 would re-enter the old SQL queries.
const opencode: ProviderAdapter = new Proxy(v1 as ProviderAdapter, {
  get(_target, key) {
    if (["id", "name", "icon", "resumeCommand"].includes(String(key))) return Reflect.get(v1, key);
    if (key === "detect") return () => ["v1", "v2"].includes(storage().schema);
    if (key === "getDataPath") return dataPath;
    if (key === "getUnavailableReason") return () => storage().note;
    if (key === "getStorageDiagnostic") return () => ({ ...storage(),
      note: storage().note || (storage().schema === "v2" ? "OpenCode v2 read-only support: ordered messages, tools, compaction, parent/fork links and token usage. Copied fork context is shown separately. Pending inbox, event replay and task/run reconstruction are not projected." : null) });
    if (key === "getStatsRevision" || key === "getProtocolRevision") return () => openCodeStorageRevision(dataPath());
    const reader = storage().schema === "v2" ? v2 : v1;
    const value = Reflect.get(reader, key);
    return typeof value === "function" ? value.bind(reader) : value;
  }
});
export default opencode;
