export function initSettingsForm({ ft, formatText, showToast }) {
  const form = document.getElementById("settings-form");
  if (!form) return;
  const editor = document.getElementById("settings-json");
  const feedback = document.getElementById("settings-feedback");
  const jsonFeedback = document.getElementById("settings-json-feedback");
  const submit = form.querySelector("button[type='submit']");
  const dirtyState = document.getElementById("settings-dirty-state");
  const initial = JSON.parse(document.getElementById("settings-initial-data")?.textContent || "{}");
  const provider = form.dataset.provider;
  let dirty = false;
  let jsonValid = true;
  const value = (id) => document.getElementById(id)?.value?.trim() || "";
  const checked = (id) => Boolean(document.getElementById(id)?.checked);
  const lines = (id) => (document.getElementById(id)?.value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const setDirty = (next) => { dirty = Boolean(next); if (dirtyState) { dirtyState.dataset.dirty = String(dirty); dirtyState.textContent = ft(dirty ? "settings_unsaved" : "settings_all_saved"); } if (submit) submit.disabled = !dirty || !jsonValid; };
  const parseJson = () => { const parsed = JSON.parse(editor.value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Configuration root must be a JSON object."); return parsed; };
  const readProjectPaths = () => { const mapping = {}; for (const line of lines("settings-project-paths-input")) { const at = line.indexOf("="); const key = at > 0 ? line.slice(0, at).trim() : ""; const directory = at > 0 ? line.slice(at + 1).trim() : ""; if (!key || !directory) throw new Error(ft("settings_project_paths_invalid")); mapping[key] = directory; } return mapping; };
  const collect = (base) => {
    const config = { ...object(base) };
    const paths = { ...object(config.projectPaths) };
    const mapping = readProjectPaths();
    if (Object.keys(mapping).length) paths[provider] = mapping; else delete paths[provider];
    if (Object.keys(paths).length) config.projectPaths = paths; else delete config.projectPaths;
    const commands = { ...object(config.resumeCommands) };
    if (!checked("settings-resume-enabled")) commands[provider] = false;
    else {
      const executable = value("settings-resume-executable");
      if (!executable) throw new Error("Resume executable is required when resume is enabled.");
      const resume = { executable, args: lines("settings-resume-args") };
      const cwd = value("settings-resume-cwd"); if (cwd) resume.cwd = cwd;
      const defaultResume = object(initial.resumeDefault);
      if (defaultResume.executable && JSON.stringify(resume) === JSON.stringify(defaultResume)) delete commands[provider]; else commands[provider] = resume;
    }
    if (Object.keys(commands).length) config.resumeCommands = commands; else delete config.resumeCommands;
    const shell = value("settings-shell-mode");
    if (!shell) delete config.resumeShell;
    else { const executable = shell === "custom" ? value("settings-shell-custom") : shell; if (!executable) throw new Error("Custom shell executable is required."); config.resumeShell = { executable, args: lines("settings-shell-args") }; }
    return config;
  };
  document.querySelector("[data-open-settings-advanced]")?.addEventListener("click", () => { const details = document.getElementById("settings-advanced"); if (details) details.open = true; });
  document.getElementById("settings-format")?.addEventListener("click", () => { try { editor.value = `${JSON.stringify(parseJson(), null, 2)}\n`; jsonValid = true; setDirty(dirty); } catch (error) { jsonValid = false; if (jsonFeedback) jsonFeedback.textContent = error.message; setDirty(dirty); } });
  document.getElementById("settings-apply-json")?.addEventListener("click", () => { try { parseJson(); jsonValid = true; setDirty(true); if (jsonFeedback) jsonFeedback.textContent = ft("settings_json_applied"); } catch (error) { jsonValid = false; if (jsonFeedback) jsonFeedback.textContent = error.message; setDirty(dirty); } });
  form.addEventListener("click", (event) => { const reset = event.target.closest?.("[data-reset-setting]"); if (!reset) return; const key = reset.dataset.resetSetting; if (key === "project-paths") document.getElementById("settings-project-paths-input").value = ""; if (key === "resume-enabled") document.getElementById("settings-resume-enabled").checked = Boolean(initial.resumeDefault?.executable); if (key === "resume-executable") document.getElementById("settings-resume-executable").value = initial.resumeDefault?.executable || ""; if (key === "resume-cwd") document.getElementById("settings-resume-cwd").value = initial.resumeDefault?.cwd || ""; if (key === "resume-args") document.getElementById("settings-resume-args").value = (initial.resumeDefault?.args || []).join("\n"); if (key === "shell-mode") document.getElementById("settings-shell-mode").value = ""; if (key === "shell-custom") document.getElementById("settings-shell-custom").value = ""; if (key === "shell-args") document.getElementById("settings-shell-args").value = ""; setDirty(true); });
  form.addEventListener("input", (event) => { if (event.target === editor) { try { parseJson(); jsonValid = true; if (jsonFeedback) jsonFeedback.textContent = ""; } catch { jsonValid = false; if (jsonFeedback) jsonFeedback.textContent = ft("settings_invalid_json"); } } setDirty(true); });
  form.addEventListener("change", () => setDirty(true));
  form.addEventListener("submit", async (event) => { event.preventDefault(); try { const config = collect(parseJson()); const response = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ config }) }); const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.validationErrors?.join(" ") || result.error || `HTTP ${response.status}`); editor.value = `${JSON.stringify(config, null, 2)}\n`; setDirty(false); if (feedback) feedback.textContent = ft("settings_saved"); showToast(ft("settings_saved"), "success"); } catch (error) { if (feedback) feedback.textContent = error.message || ft("settings_validation_error"); showToast(ft("toast_error"), "error"); } finally { if (submit) submit.disabled = !dirty || !jsonValid; } });
}
