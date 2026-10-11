// Public startup configuration contract: crates/app/src/config.rs and main.rs.
export const sourceGuidance = [
  { provider: 'codex', label: 'Codex', key: 'codexDir', flag: '--codex-dir', environment: 'AGENTSESSION_CODEX_DIR' },
  { provider: 'opencode', label: 'OpenCode', key: 'dbPath', flag: '--opencode-db', environment: 'AGENTSESSION_DB_PATH' },
  { provider: 'claude-code', label: 'Claude Code', key: 'claudeDir', flag: '--claude-dir', environment: 'AGENTSESSION_CLAUDE_DIR' },
  { provider: 'pi', label: 'Pi', key: 'piDir', flag: '--pi-dir', environment: 'AGENTSESSION_PI_DIR' },
  { provider: 'deepseek-harness', label: 'DeepSeek Harness', key: 'dshDir', flag: '--dsh-dir', environment: 'AGENTSESSION_DSH_DIR' },
] as const;

export function sourceSettingsHref(provider: string): string {
  return '/settings#source-' + encodeURIComponent(provider);
}
