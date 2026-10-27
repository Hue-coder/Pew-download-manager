# ⚡ Pew Download Manager

<p align="center">
  <img src="crates/pew-gui/icons/128x128.png" width="96" height="96" alt="Pew Download Manager Logo" />
</p>

<p align="center">
  <strong>A blazing-fast, modern, multi-connection Download Manager and Video Grabber built entirely in Rust and Tauri.</strong>
</p>

<p align="center">
  <a href="https://github.com/Hue-coder/Pew-download-manager/releases/latest"><img src="https://img.shields.io/github/v/release/Hue-coder/Pew-download-manager?style=flat-square&color=6366f1" alt="Latest Release"></a>
  <a href="https://www.rust-lang.org/"><img src="https://img.shields.io/badge/Language-Rust_1.80+-orange.svg?style=flat-square" alt="Rust"></a>
  <a href="https://tauri.app/"><img src="https://img.shields.io/badge/GUI-Tauri_v2-24C8DB.svg?style=flat-square" alt="Tauri"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="License: MIT"></a>
  <a href="https://github.com/Hue-coder/Pew-download-manager/releases"><img src="https://img.shields.io/github/downloads/Hue-coder/Pew-download-manager/total?style=flat-square&color=10b981" alt="Total Downloads"></a>
</p>

---

## 📥 Downloads (Latest Release v0.1.1)

Get the latest official packages directly from GitHub Releases:

| Package | Format | Architecture | Download Link | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Windows Setup Wizard** *(Recommended)* | `.exe` | Windows x64 | [⬇️ **Download Setup .exe**](https://github.com/Hue-coder/Pew-download-manager/releases/latest/download/Pew%20Download%20Manager_0.1.1_x64-setup.exe) | Standard Windows installer with desktop & start menu shortcuts. Bundles all media tools. |
| **Windows MSI Package** | `.msi` | Windows x64 | [⬇️ **Download MSI**](https://github.com/Hue-coder/Pew-download-manager/releases/latest/download/Pew%20Download%20Manager_0.1.1_x64_en-US.msi) | Windows enterprise / installer package. |
| **Portable Standalone** | `.zip` | Windows x64 | [⬇️ **Download Portable .zip**](https://github.com/Hue-coder/Pew-download-manager/releases/latest/download/Pew-Download-Manager-Windows-x64.zip) | Portable version — extract and run immediately without installation. |
| **Browser Extension** | `.zip` | Universal (MV3) | [⬇️ **Download Extension .zip**](https://github.com/Hue-coder/Pew-download-manager/releases/latest/download/pew-browser-extension.zip) | Manifest V3 extension for Chrome, Edge, Brave, and Chromium browsers. |

👉 Browse all release assets and changelogs on the [**GitHub Releases Page**](https://github.com/Hue-coder/Pew-download-manager/releases).

---

## ✨ Key Features

- 🚀 **High-Speed Dynamic Segmentation:** Splits large files into up to 32 parallel chunk ranges (`Range: bytes=start-end`) using multi-threaded asynchronous HTTP/2 & HTTP/1.1 connections.
- 💾 **Zero-Merge Direct Disk I/O:** Pre-allocates target files and writes chunks directly to exact byte offsets. Eliminates lengthy post-download merging freezes for multi-gigabyte files.
- 🎬 **In-Page Video & Audio Grabber:** Intelligent media sniffer for **YouTube** (4K, 2K, 1080p, 720p, MP3/WAV/M4A), **Pinterest** HLS videos, Facebook, TikTok, Twitter/X, and direct media streams.
- 📦 **100% Standalone (Zero Dependencies):** Comes bundled with standalone `yt-dlp` and `ffmpeg` binaries. **No Python or manual external tools required** on client machines.
- 🪟 **Modern AB-Download-Manager-Inspired Dark UI:** Clean, dark-mode desktop interface with category filters, live transfer rates, speed gauges, and search.
- 📌 **Draggable & Minimizable Progress Windows:** Download progress displays both inside the desktop app and in sleek, movable, floating popup widgets with cancel and minimize controls.
- 🔕 **Silent Background Execution:** Fully headless background calls utilizing Win32 `CREATE_NO_WINDOW` flags. No annoying command prompt windows ever flash or pop up.
- 🛡️ **System Tray & Autostart Integration:** Runs quietly in the Windows system tray with quick actions to open the app, jump to downloads folder, or manage active transfers.

---

## 💻 Installation & Setup

### 1. Desktop Application Installation

#### Option A: Windows Installer (Setup Wizard)
1. Download **[Pew Download Manager_0.1.1_x64-setup.exe](https://github.com/Hue-coder/Pew-download-manager/releases/latest/download/Pew%20Download%20Manager_0.1.1_x64-setup.exe)**.
2. Double-click the installer and follow the **Next > Install** steps.
3. Pew will automatically create Start Menu & Desktop shortcuts and launch silently into the System Tray.

#### Option B: Portable Mode
1. Download **[Pew-Download-Manager-Windows-x64.zip](https://github.com/Hue-coder/Pew-download-manager/releases/latest/download/Pew-Download-Manager-Windows-x64.zip)**.
2. Extract the archive to any folder of your choice.
3. Run `pew-gui.exe` directly.

---

### 2. Browser Extension Setup (Chrome / Edge / Brave / Opera)

The Pew browser extension enables one-click media grabbing and automatic download interception:

1. Download and extract **[pew-browser-extension.zip](https://github.com/Hue-coder/Pew-download-manager/releases/latest/download/pew-browser-extension.zip)** (or use the `extensions/pew-browser-extension` folder in the repository).
2. Open your Chromium-based browser and navigate to the Extensions page:
   - **Google Chrome / Brave:** `chrome://extensions`
   - **Microsoft Edge:** `edge://extensions`
3. Enable **Developer mode** using the toggle switch in the top right corner.
4. Click the **Load unpacked** button in the top left.
5. Select the extracted `pew-browser-extension` folder.
6. The **Pew Grabber** icon will appear in your browser toolbar. Now open any video on YouTube or Pinterest to see the floating download button!

---

## 🎬 How the In-Page Video Grabber Works

When browsing video sites with the Pew Extension enabled:
1. **Floating Download Button:** A sleek download pill appears directly over the video player (e.g. YouTube, Pinterest).
2. **Quality Selection:** Click the pill to select your desired format:
   - **4K Ultra HD (2160p)**
   - **2K Quad HD (1440p)**
   - **1080p Full HD**
   - **720p HD / 480p SD / 360p**
   - **Audio Only (High-Quality MP3, Lossless WAV, AAC/M4A)**
3. **Movable Progress Popup:** Clicking any format immediately launches the download in Pew and displays a draggable, minimizable floating progress window at the bottom right.
4. **Direct Open Actions:** Once completed, click **Open File** or **Open Folder** directly from the popup to access your downloaded media.

---

## 🏗️ Project Architecture

```text
Pew-download-manager/
├── Cargo.toml                    # Root workspace & release profile optimizations
├── build-release.ps1             # One-click automated release packaging script
├── crates/
│   ├── pew-core/                 # High-performance async segmented download engine
│   │   ├── src/
│   │   │   ├── downloader.rs     # Multi-connection chunked stream coordinator
│   │   │   ├── chunk.rs          # Byte-range offset calculator & state writer
│   │   │   ├── metadata.rs       # Server capabilities probing & filename resolution
│   │   │   └── error.rs          # Unified error handling
│   │   └── Cargo.toml
│   ├── pew-cli/                  # Terminal client with live progress indicators
│   └── pew-gui/                  # Desktop application (Tauri v2 + Dark UI + Tray)
│       ├── bin/                  # Bundled standalone yt-dlp & ffmpeg binaries
│       ├── ui/                   # AB-Download-Manager inspired responsive dark interface
│       ├── tauri.conf.json       # App metadata, bundle configurations, & window specs
│       └── src/main.rs           # Local RPC server, protocol registration, & muxing
└── extensions/
    └── pew-browser-extension/    # Manifest V3 browser extension & video sniffer
        ├── background.js         # Service worker & local Pew RPC communicator
        ├── content.js            # Video player detector & floating overlay
        ├── content.css           # Modern dark-mode floating widget styles
        ├── popup.html / popup.js # Extension toolbar manager
        └── manifest.json         # Extension permissions & entrypoints
```

---

## 🛠️ Building from Source

### Prerequisites
- [Rust Toolchain (1.80+)](https://rustup.rs/)
- [Node.js (v18+)](https://nodejs.org/)

### 1. Clone the Repository
```bash
git clone https://github.com/Hue-coder/Pew-download-manager.git
cd Pew-download-manager
```

### 2. One-Click Automated Build
Run the included PowerShell packaging script to build optimized binaries, installers, and extension archives in one command:
```powershell
.\build-release.ps1
```
All release bundles (`.exe` setup, `.msi`, `.zip`, and extension) will be placed in the `./dist/` folder.

### 3. Manual Component Builds

#### Desktop GUI (Release Binary)
```bash
cargo build --release -p pew-gui
```
The optimized executable (`pew-gui.exe`) will be generated at `target/release/pew-gui.exe`.

#### Desktop Installers (NSIS Setup & MSI)
```bash
cd crates/pew-gui
npx @tauri-apps/cli build
```
Installers will be generated under `target/release/bundle/nsis/` and `target/release/bundle/msi/`.

#### Command-Line Client (CLI)
```bash
cargo run -p pew-cli -- download "https://speed.hetzner.de/100MB.bin" --parts 8
```

---

## ⌨️ Command Line Interface (CLI) Options

```bash
# Download with 16 parallel connections to a specific folder
cargo run -p pew-cli -- download "https://example.com/file.zip" --parts 16 --output ./downloads --filename archive.zip

# Check file headers without downloading
cargo run -p pew-cli -- probe "https://example.com/movie.mp4"
```

| Flag | Shorthand | Description | Default |
| :--- | :--- | :--- | :--- |
| `--parts` | `-p` | Number of concurrent connection segments | `8` |
| `--output` | `-o` | Target download directory | Current Directory |
| `--filename` | `-n` | Custom output filename | Auto-detected from URL/Headers |

---

## 🗺️ Roadmap & Status

- [x] **High-Speed Segmented Engine:** Multi-part parallel byte-range downloader (`pew-core`).
- [x] **Zero-Merge Disk Writing:** Pre-allocated direct-to-offset chunk writing.
- [x] **AB-Download-Manager Redesign:** Modern dark UI with categories, transfer statistics, and search.
- [x] **Draggable Floating Popups:** Moveable, minimizable download progress bars.
- [x] **Full YouTube 4K/1080p Support:** Standalone `yt-dlp` and `ffmpeg` engine integration.
- [x] **Pinterest HLS Support:** Direct Pin stream downloader with audio extraction.
- [x] **Quiet Windows Integration:** Zero command window flashes with `CREATE_NO_WINDOW`.
- [x] **System Tray & Autostart:** Windows background launch, auto-start, and protocol handler (`pew://`).
- [x] **Automated CI/CD Releases:** GitHub Actions workflow building NSIS, MSI, and portable packages on every tag.

---

## 🤝 Contributing

Contributions, feedback, and issue reports are always welcome!
- Found a bug or have a suggestion? Open an [Issue](https://github.com/Hue-coder/Pew-download-manager/issues).
- Want to contribute code? Submit a [Pull Request](https://github.com/Hue-coder/Pew-download-manager/pulls).

---

## 📜 License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more details.
