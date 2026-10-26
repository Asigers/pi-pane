# Pi Pane

**A minimal Windows desktop window for your existing local Pi Coding Agent.**

Pi Pane is not a new coding agent. It controls your installed `pi --mode rpc` process and reuses your providers, models, skills, extensions, tools and session files. The desktop window is a thin Tauri 2/WebView2 layer.

> **M3 candidate:** source, unit tests, Windows CI, and NSIS packaging workflow are in the repository. See [STATUS](docs/STATUS.md) for what has and has not passed. Unsigned Windows builds are development artifacts, not vetted stable releases.

## Features

- Local Pi RPC over stdin/stdout JSONL (no cloud proxy or duplicate agent).
- Streaming assistant messages, collapsible tool output and thinking, rich Markdown, syntax-highlighted code with one-click copy.
- New/resume sessions (current directory), models, thinking levels, context footer.
- Built-in command handling and Pi extension command passthrough.
- Extension `select` / `confirm` / `input` / `editor` requests; extension status and text widgets.
- Stop/queue messages, context compact/export, graceful Pi shutdown and Windows process-tree cleanup.
- Deliberately **not an IDE**: no file tree, Git workbench or extra backend server.

## Windows

See **[Windows install and development](docs/WINDOWS.md)**. Requires Windows 10/11 x64, WebView2, and an independently installed Pi that already works in your terminal.

```powershell
git clone https://github.com/Asigers/pi-pane.git
cd pi-pane
npm install
npm test
npm run dev
```

Build an unsigned NSIS installer on Windows:

```powershell
npm run build:windows
```

CI-generated installers are uploaded to **[Windows Actions](https://github.com/Asigers/pi-pane/actions/workflows/windows.yml)** when a run succeeds.

## Design and implementation

- [Implementation design](docs/IMPLEMENTATION_DESIGN.md)
- [Acceptance and known limitations](docs/STATUS.md)
- [Windows guide](docs/WINDOWS.md)

Pi remains the owner of all model/tool behavior. RPC cannot render Pi's TUI-only custom component APIs such as `ctx.ui.custom()` or custom TUI Footer. The **TUI 回退** action disconnects Pi before you continue the session in a terminal, preventing simultaneous writes.

## Resource use

Stack: Tauri 2, Rust/Tokio, system WebView2, Preact, TypeScript. No Electron or extra Node backend; **the separately installed Pi process still consumes resources**. Idle GUI budget: target under 150 MiB, pending independent Windows measurement; see `scripts/measure.ps1`.

## License

No repository license has been selected yet. 
