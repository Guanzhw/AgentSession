mod browser;
mod config;
mod mcp;
mod mcp_input;
mod resume;
mod web;

use agentsession_core::Core;
use clap::{Args, Parser, Subcommand};
use std::{path::PathBuf, sync::Arc};

#[derive(Parser)]
#[command(
    name = "agentsession-v3",
    version,
    about = "AgentSession 3.0 local Reader and MCP"
)]
struct Cli {
    /// Select a JSON configuration file; Settings saves runtime overrides here.
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Serve {
        #[arg(long)]
        port: Option<u16>,
        #[arg(long)]
        disable_terminal_launch: bool,
        /// Open the loopback Viewer in the system's default browser.
        #[arg(long)]
        open: bool,
        #[command(flatten)]
        sources: SourceArgs,
    },
    Mcp {
        #[command(flatten)]
        sources: SourceArgs,
    },
    /// Import a 2.0 Viewer metadata copy into this 3.0 source scope once.
    MigrateMeta {
        #[arg(long = "from", value_name = "OLD_META_DB")]
        from: PathBuf,
        #[command(flatten)]
        sources: SourceArgs,
    },
}

#[derive(Args, Default)]
struct SourceArgs {
    #[arg(long)]
    codex_dir: Option<PathBuf>,
    #[arg(long)]
    opencode_db: Option<PathBuf>,
    #[arg(long)]
    claude_dir: Option<PathBuf>,
    #[arg(long)]
    pi_dir: Option<PathBuf>,
    #[arg(long)]
    dsh_dir: Option<PathBuf>,
    #[arg(long)]
    meta_dir: Option<PathBuf>,
    #[arg(long)]
    index_dir: Option<PathBuf>,
    #[arg(long)]
    cache_dir: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let selected = config::SelectedConfig::load(cli.config)?;
    match cli.command {
        Command::Serve {
            port,
            sources,
            disable_terminal_launch,
            open,
        } => {
            let port = selected.serve_port(port)?;
            let sources = selected.resolve(sources)?;
            let settings = selected.settings_snapshot(&sources, port);
            let core = Arc::new(Core::new(sources)?);
            web::serve(
                core,
                port,
                settings,
                selected.resume_config(disable_terminal_launch),
                selected.token_pricing(),
                selected.open_browser(open),
            )
            .await?;
        }
        Command::Mcp { sources } => {
            let sources = selected.resolve(sources)?;
            let core = Arc::new(Core::new(sources)?);
            mcp::serve(core, selected.mcp_limits()).await?;
        }
        Command::MigrateMeta { from, sources } => {
            let core = Core::new(selected.resolve(sources)?)?;
            core.import_viewer_metadata(&from)?;
            println!("{}", core.source_scope());
        }
    }
    Ok(())
}
