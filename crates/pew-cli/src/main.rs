use std::path::PathBuf;
use clap::{Parser, Subcommand};
use indicatif::{ProgressBar, ProgressStyle};
use tokio::sync::mpsc;
use pew_core::{Downloader, DownloadConfig, DownloadEvent};

#[derive(Parser)]
#[command(name = "pew")]
#[command(about = "Pew - Blazing fast multi-connection download manager written in Rust", long_about = None)]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Download a file with multi-part segmentation
    Download {
        /// Target URL to download
        url: String,

        /// Number of parallel segments/connections (default: 8)
        #[arg(short, long, default_value_t = 8)]
        parts: usize,

        /// Output directory (default: current directory)
        #[arg(short, long)]
        output: Option<PathBuf>,

        /// Custom filename
        #[arg(short, long)]
        name: Option<String>,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Download {
            url,
            parts,
            output,
            name,
        } => {
            let output_dir = output.unwrap_or_else(|| std::env::current_dir().unwrap());
            let config = DownloadConfig {
                parts,
                ..Default::default()
            };

            let downloader = Downloader::new(config);
            let (tx, mut rx) = mpsc::unbounded_channel::<DownloadEvent>();

            println!("⚡ Connecting to {} ...", url);

            // Handle progress in another task
            let progress_handle = tokio::spawn(async move {
                let mut pb: Option<ProgressBar> = None;

                while let Some(event) = rx.recv().await {
                    match event {
                        DownloadEvent::Started { total_bytes, parts, filename } => {
                            println!("🚀 Starting download: {} (Parts: {})", filename, parts);
                            let bar = if let Some(total) = total_bytes {
                                let b = ProgressBar::new(total);
                                b.set_style(
                                    ProgressStyle::default_bar()
                                        .template("{spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {bytes}/{total_bytes} ({bytes_per_sec}, ETA {eta})")
                                        .unwrap()
                                        .progress_chars("#>-")
                                );
                                b
                            } else {
                                let b = ProgressBar::new_spinner();
                                b.set_style(
                                    ProgressStyle::default_spinner()
                                        .template("{spinner:.green} [{elapsed_precise}] {bytes} ({bytes_per_sec})")
                                        .unwrap()
                                );
                                b
                            };
                            pb = Some(bar);
                        }
                        DownloadEvent::Progress { downloaded, .. } => {
                            if let Some(ref bar) = pb {
                                bar.set_position(downloaded);
                            }
                        }
                        DownloadEvent::Completed { path, total_bytes } => {
                            if let Some(ref bar) = pb {
                                bar.finish_with_message("Done!");
                            }
                            let human_size = format_size(total_bytes);
                            println!("\n✅ Successfully downloaded to: {}", path.display());
                            println!("📦 Total size: {}", human_size);
                        }
                        DownloadEvent::Error(err) => {
                            eprintln!("\n❌ Download failed: {}", err);
                        }
                    }
                }
            });

            match downloader.download(&url, &output_dir, name.as_deref(), Some(tx)).await {
                Ok(_) => {
                    let _ = progress_handle.await;
                }
                Err(err) => {
                    eprintln!("❌ Error: {}", err);
                }
            }
        }
    }

    Ok(())
}

fn format_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;

    if bytes >= GB {
        format!("{:.2} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.2} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.2} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}
