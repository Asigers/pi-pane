# Pi Pane

**A minimal Windows desktop interface for your local Pi Coding Agent.**

Pi Pane is a lightweight graphical shell for an existing local Pi installation. Pi remains responsible for the models, tools, extensions, settings, and sessions; Pi Pane focuses on chat, Markdown, tool-output display, keyboard interaction, and convenient code copying.

> Status: design phase. The repository does not contain a working application yet.

## Principles

- **Local Pi first:** communicate with the installed `pi --mode rpc`; do not reimplement the agent.
- **Lightweight:** Tauri 2 + system WebView2, with no bundled browser engine or second agent runtime.
- **Windows first:** Windows 10/11 x64 initially.
- **TUI-like, not an IDE:** no file explorer, Git workbench, or multi-agent dashboard in the MVP.
- **Honest compatibility:** TUI-only extension widgets cannot be reproduced automatically through RPC.

## Design document

**[Implementation Design / 实现设计文档](docs/IMPLEMENTATION_DESIGN.md)** — goals, stack, Windows integration, RPC architecture, feature scope, resource budgets, milestones, and acceptance criteria.

## Status

- [x] Architecture and scope specified
- [ ] Windows development skeleton
- [ ] Local Pi RPC connectivity
- [ ] Streaming chat + Markdown/code copy
- [ ] Session/command compatibility
- [ ] Windows installer and measured performance

## References

- [Pi RPC protocol](https://pi.dev/docs/latest/rpc)
- [Pi RPC commands](https://pi.dev/docs/latest/rpc-commands)
- [Pi RPC extension UI](https://pi.dev/docs/latest/rpc-extension-ui)
- [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/)

## License

License decision pending; no license has been granted by this README.
