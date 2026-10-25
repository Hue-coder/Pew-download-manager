# ⚡ Pew Download Manager

> **Pew** is an open-source, blazing-fast, multi-connection Internet Download Manager alternative built entirely in **Rust**.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Language: Rust](https://img.shields.io/badge/Language-Rust-orange.svg)](https://www.rust-lang.org/)
[![Status: Under Active Development](https://img.shields.io/badge/Status-Active_Development-brightgreen.svg)]()

---

## 🌟 Key Features

- 🚀 **High-Speed Dynamic Segmentation:** Splits files into multiple byte ranges (`Range: bytes=start-end`) downloaded concurrently over asynchronous HTTP/2 & HTTP/1.1 connections.
- 💾 **Zero-Merge Disk I/O:** Pre-allocates target files and writes chunks directly to byte offsets. No waiting for gigabyte-sized files to merge after downloading completes.
- 🔄 **Smart Fallback:** Automatically falls back to standard single-connection streaming if the remote server does not advertise `Accept-Ranges`.
- 📊 **Real-time Metrics:** Live speed calculation, progress reporting, ETA estimation, and event channels.
- 🌐 **Browser Integration (Coming Soon):** Chrome & Firefox Native Messaging integration for automatic download interception, media sniffing, and authentication cookie forwarding.
- 🖥️ **Desktop GUI (Coming Soon):** Lightweight, modern desktop GUI built with Tauri v2.

---

## 🏗️ Project Architecture

```text
pew-download-manager/
├── Cargo.toml                    # Root workspace configuration
├── crates/
│   ├── pew-core/                 # High-performance async download engine library
│   │   ├── src/
│   │   │   ├── downloader.rs     # Segmented & single stream download handlers
│   │   │   ├── chunk.rs          # Byte range calculation & state
│   │   │   ├── metadata.rs       # Server probing & filename extraction
│   │   │   └── error.rs          # Structured error handling
│   │   └── Cargo.toml
│   └── pew-cli/                  # Terminal-based client with live progress bar
│       ├── src/
│       │   └── main.rs
│       └── Cargo.toml
└── extensions/                   # (Upcoming) WebExtension for Chrome/Firefox
```

---

## 🚀 Getting Started

### Prerequisites

- [Rust Toolchain (1.80+)](https://rustup.rs/)

### Build from Source

```bash
# Clone the repository
git clone https://github.com/Hue-coder/Pew-download-manager.git
cd Pew-download-manager

# Build in release mode
cargo build --release
```

### Usage (CLI)

```bash
# Download a file using 8 parallel connections
cargo run -p pew-cli -- download https://speed.hetzner.de/100MB.bin --parts 8

# Specify output directory and custom filename
cargo run -p pew-cli -- download https://example.com/archive.zip -p 16 -o ./downloads -n myfile.zip
```

---

## 🗺️ Roadmap

- [x] **Phase 1: Core Engine**
  - [x] Multi-connection segmented downloading with byte offsets
  - [x] Zero-merge direct disk I/O
  - [x] Live progress, speed, and ETA tracking
  - [x] CLI interface with styled progress bar (`indicatif`)
- [ ] **Phase 2: State Persistence & Resuming**
  - [ ] `.pew.meta` metadata tracking for paused/interrupted downloads
  - [ ] ETag and Last-Modified validation on resume
- [ ] **Phase 3: Browser Extension & Native Host**
  - [ ] Chrome / Firefox Native Messaging Host binary
  - [ ] Download interception on `chrome.downloads.onCreated`
  - [ ] Video/Audio media sniffer (M3U8 / MPD / MP4)
- [ ] **Phase 4: Desktop GUI & Packaging**
  - [ ] Modern UI with Tauri v2
  - [ ] Automated `.exe` (NSIS) and `.msi` (WiX) releases via GitHub Actions

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome!  
Feel free to check out the [issues page](https://github.com/Hue-coder/Pew-download-manager/issues).

---

## 📜 License

Distributed under the MIT License. See `LICENSE` for more information.
