<script lang="ts">
  import type { SettingsSnapshot, RuntimeSettings } from './api';
  import { saveSettings } from './api';
  import { language, t } from './i18n';

  export let settings: SettingsSnapshot;
  let commands = JSON.stringify(settings.runtime.resumeCommands, null, 2);
  let shell = JSON.stringify(settings.runtime.resumeShell, null, 2);
  let projectPaths = JSON.stringify(settings.runtime.projectPaths, null, 2);
  let tokenPricing = JSON.stringify(settings.runtime.tokenPricing, null, 2);
  let pricingMessage = '';
  let pricingError = '';
  let saving = false;
  let message = '';
  let error = '';
  let projectMessage = '';
  let projectError = '';

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    error = ''; message = '';
    const update: Partial<RuntimeSettings> = {};
    try {
      if (commands !== JSON.stringify(settings.runtime.resumeCommands, null, 2)) update.resumeCommands = JSON.parse(commands);
      if (shell !== JSON.stringify(settings.runtime.resumeShell, null, 2)) update.resumeShell = JSON.parse(shell);
    }
    catch { error = t($language, 'Invalid JSON. Check the command and shell entries.'); return; }
    if (Object.keys(update).length === 0) { message = t($language, 'No changes to save.'); return; }
    saving = true;
    try {
      settings = await saveSettings(update);
      commands = JSON.stringify(settings.runtime.resumeCommands, null, 2);
      shell = JSON.stringify(settings.runtime.resumeShell, null, 2);
      message = t($language, 'Resume settings saved. New capability checks and terminal launches use these settings immediately.');
    } catch (cause) { error = cause instanceof Error ? cause.message : t($language, 'Could not save resume settings.'); }
    finally { saving = false; }
  }

  async function saveProjects(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    projectError = ''; projectMessage = '';
    let value: RuntimeSettings['projectPaths'];
    try { value = JSON.parse(projectPaths); }
    catch { projectError = t($language, 'Invalid JSON. Check the project paths.'); return; }
    if (projectPaths === JSON.stringify(settings.runtime.projectPaths, null, 2)) {
      projectMessage = t($language, 'No changes to save.');
      return;
    }
    saving = true;
    try {
      settings = await saveSettings({ projectPaths: value });
      projectPaths = JSON.stringify(settings.runtime.projectPaths, null, 2);
      projectMessage = t($language, 'Project paths saved.');
    } catch (cause) { projectError = cause instanceof Error ? cause.message : t($language, 'Could not save project paths.'); }
    finally { saving = false; }
  }

  async function savePricing(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    pricingError = ''; pricingMessage = '';
    let value: RuntimeSettings['tokenPricing'];
    try { value = JSON.parse(tokenPricing); }
    catch { pricingError = t($language, 'Invalid JSON. Check the token pricing.'); return; }
    if (tokenPricing === JSON.stringify(settings.runtime.tokenPricing, null, 2)) {
      pricingMessage = t($language, 'No changes to save.'); return;
    }
    saving = true;
    try {
      settings = await saveSettings({ tokenPricing: value });
      tokenPricing = JSON.stringify(settings.runtime.tokenPricing, null, 2);
      pricingMessage = t($language, 'Token pricing saved. New statistics requests use these rates immediately.');
    } catch (cause) { pricingError = cause instanceof Error ? cause.message : t($language, 'Could not save token pricing.'); }
    finally { saving = false; }
  }

  const labels: Record<string, string> = {
    codexDir: 'Codex', dbPath: 'OpenCode', claudeDir: 'Claude Code',
    piDir: 'Pi', dshDir: 'DeepSeek Harness', metaDir: 'Viewer metadata',
    indexDir: 'Search index', cacheDir: 'Cache',
  };

  function settingLabel(key: string): string {
    const value = labels[key] || key;
    return value === 'Viewer metadata' ? t($language, 'Viewer metadata')
      : value === 'Search index' ? t($language, 'Search index')
        : value === 'Cache' ? t($language, 'Cache') : value;
  }
</script>

<main class="settings-page">
  <p class="eyebrow">{t($language, 'Local configuration')}</p>
  <h1>{t($language, 'Settings')}</h1>
  <p class="intro-copy">{t($language, 'These are the paths and port selected for this running AgentSession 3.0 process.')}</p>

  <section class="settings-panel" aria-labelledby="settings-resume-heading">
    <h2 id="settings-resume-heading">{t($language, 'Resume in terminal')}</h2>
    <p>{t($language, 'Save command overrides for this running Viewer and its next restart. The process startup option can still disable terminal launching.')}</p>
    <form onsubmit={save}>
      <label for="resume-commands">{t($language, 'Provider commands (JSON)')}</label>
      <p id="commands-help">{t($language, 'Omit a provider to use its default. Use false to disable it. A command has executable, args and optional cwd fields; arguments can use {sessionId} and {projectPath}.')}</p>
      <textarea id="resume-commands" aria-describedby="commands-help" rows="10" spellcheck="false" bind:value={commands} disabled={saving}></textarea>
      <label for="resume-shell">{t($language, 'Terminal shell (JSON)')}</label>
      <p id="shell-help">{t($language, 'Use null for the default shell, or an object with executable and args. Windows requires PowerShell 7.3 or newer.')}</p>
      <textarea id="resume-shell" aria-describedby="shell-help" rows="5" spellcheck="false" bind:value={shell} disabled={saving}></textarea>
      <button class="read-more" type="submit" disabled={saving}>{saving ? t($language, 'Saving…') : t($language, 'Save resume settings')}</button>
      {#if message}<p role="status">{message}</p>{/if}
      {#if error}<p class="content-error" role="alert">{error}</p>{/if}
    </form>
  </section>

  <section class="settings-panel" aria-labelledby="settings-projects-heading">
    <h2 id="settings-projects-heading">{t($language, 'Project paths')}</h2>
    <p>{t($language, 'Save project mappings in this Viewer\'s configuration; each value must be an absolute path. Current adapters have no verified project-key lookup, so these mappings do not change session directories or resume working directories.')}</p>
    <form onsubmit={saveProjects}>
      <label for="project-paths">{t($language, 'Provider project maps (JSON)')}</label>
      <textarea id="project-paths" rows="8" spellcheck="false" bind:value={projectPaths} disabled={saving}></textarea>
      <button class="read-more" type="submit" disabled={saving}>{saving ? t($language, 'Saving…') : t($language, 'Save project paths')}</button>
      {#if projectMessage}<p role="status">{projectMessage}</p>{/if}
      {#if projectError}<p class="content-error" role="alert">{projectError}</p>{/if}
    </form>
  </section>

  <section class="settings-panel" aria-labelledby="settings-pricing-heading">
    <h2 id="settings-pricing-heading">{t($language, 'Token pricing')}</h2>
    <p id="pricing-help">{t($language, 'Enter your rates per million tokens, keyed by the recorded model provider and model (vendor/model). Each entry requires currency, inputPerMillion and outputPerMillion. Optional fields: reasoningPerMillion, cacheReadPerMillion, cacheWritePerMillion, sourceLabel, sourceUrl and asOf. Select that model in Stats to estimate cost.')}</p>
    <form onsubmit={savePricing}>
      <label for="token-pricing">{t($language, 'Model pricing (JSON)')}</label>
      <textarea id="token-pricing" aria-describedby="pricing-help" rows="12" spellcheck="false" bind:value={tokenPricing} disabled={saving}></textarea>
      <button class="read-more" type="submit" disabled={saving}>{saving ? t($language, 'Saving…') : t($language, 'Save token pricing')}</button>
      {#if pricingMessage}<p role="status">{pricingMessage}</p>{/if}
      {#if pricingError}<p class="content-error" role="alert">{pricingError}</p>{/if}
    </form>
  </section>

  <section class="settings-panel" aria-labelledby="settings-config-heading">
    <h2 id="settings-config-heading">{t($language, 'Configuration file')}</h2>
    <p>{settings.configFile.loaded ? t($language, 'Loaded at startup') : t($language, 'No configuration file found; defaults, environment, and CLI values were used.')}</p>
    <code>{settings.configFile.path}</code>
  </section>

  <section class="settings-panel" aria-labelledby="settings-sources-heading">
    <h2 id="settings-sources-heading">{t($language, 'Provider sources')}</h2>
    <dl>
      {#each Object.entries(settings.startup.sources) as [key, value] (key)}
        <div><dt>{settingLabel(key)}</dt><dd><code>{value}</code></dd></div>
      {/each}
    </dl>
  </section>

  <section class="settings-panel" aria-labelledby="settings-process-heading">
    <h2 id="settings-process-heading">{t($language, 'Process and Viewer state')}</h2>
    <dl>
      <div><dt>{t($language, 'HTTP port')}</dt><dd><code>{settings.startup.port}</code></dd></div>
      {#each Object.entries(settings.startup.state) as [key, value] (key)}
        <div><dt>{settingLabel(key)}</dt><dd><code>{value}</code></dd></div>
      {/each}
    </dl>
    <p>{t($language, 'Source and state paths are selected when the process starts. Change the CLI, environment, or configuration file and restart to apply them.')}</p>
  </section>
</main>

<style>
  form { display: grid; gap: 12px; }
  label { font-weight: 600; }
  textarea { width: 100%; box-sizing: border-box; padding: 12px; border: 1px solid var(--border-control); border-radius: 6px; background: var(--input-background); color: var(--ink); font: 13px/1.5 monospace; resize: vertical; }
  textarea:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  form p { margin: 0; }
  form button { justify-self: start; }
</style>
