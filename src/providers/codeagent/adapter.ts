import os from "node:os";
import path from "node:path";
import { icons } from "../../icons.js";
import { createOpenCodeAdapter } from "../opencode/adapter.js";

function defaultDataPath() {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "db", "ngagent.db");
}

const codeagent = createOpenCodeAdapter({
  id: "codeagent",
  name: "CodeAgent",
  icon: icons.codeagent,
  defaultDataPath
});

export default codeagent;
