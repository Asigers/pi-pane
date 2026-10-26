# 实现与验收状态

日期：2026-10-26。本文按实现代码 / 自动化验证 / Windows 实机验收三个层次记录，**不能用提交代码代替实际通过测试**。

| 阶段 | 已实现的内容 | 自动化验证 | Windows 实机验收 |
| --- | --- | --- | --- |
| M0 | Tauri 2 / Preact / Rust 工程，Pi 路径与 cwd、RPC JSONL 桥接 | Windows CI 运行中 | 未完成 |
| M1 | 发送、流式消息重建、Markdown、代码复制、工具记录、停止 | Vitest 协议 reducer 用例，Rust 编译待验证 | 未完成 |
| M2 | 会话恢复、新会话、模型、思考等级、扩展 select/confirm/input/editor、工具状态、命令映射 | 基础单测，端到端未覆盖 | 未完成 |
| M3 | CI、Windows NSIS 打包步骤、进程清理、资源测量脚本、安装文档 | Windows CI 运行中 | 未完成 |

## 有意不支持

- 通过 RPC 无法直接呈现 Pi 的 `ctx.ui.custom()`、自定义 Footer/Header/TUI 编辑器。使用“ TUI 回退”先断开 RPC，再手动在终端执行 `pi --continue`。
- 没有文件树、Git 面板、IDE、插件市场；这是项目边界，而不是缺失的计划功能。
- 跨所有项目的会话扫描/会话层级关系尚未实现；“恢复会话”按当前项目目录检索默认会话路径及 `PI_CODING_AGENT_SESSION_DIR` 环境变量，未读取 settings.json 的自定义 sessionDir。
- 未做正式版本签名。GitHub Actions 的构建产物是 **unsigned**，不能声称可信发布版。
- UI 暂不提供图片附件、会话分叉树可视化、Pi TUI 的所有快捷键。
- 部分终端专用扩展可能在 RPC 模式不工作。

## 验收计划（Windows 11 x64）

1. `npm install`、`npm test`、`npm run check`、`npm run build:windows` 均通过。
2. 双击 NSIS 安装包运行，不出现白屏或 WebView2 缺失时的无提示崩溃。
3. 在一个含空格和中文目录的项目中通过 npm 安装的本地 pi.cmd 连接，不改动用户已有配置和凭证。
4. 用本机已配置的模型发送 Prompt，实时显示文字、工具开始/结束和错误；工具正常执行，不重复发送 Prompt。
5. 关闭窗口、重新打开，继续最近会话；停止中断不会重复执行已提交工具。
6. 使用 /new、/resume、模型/思考选择以及 Extension confirm/select/input/editor。
7. 实测 1000 条消息、10 MB 工具输出、空闲 10 分钟、Windows 10/11 的 CPU/Private Working Set（包含 WebView2 多进程），与低占用预算对比。
8. 通过 NSIS 安装/卸载，验证无驻留 pi.cmd/node.exe 子进程。遇到 Pi 扩展自定义组件使用原生 TUI 路线。

## M3 发布判定

只有当 **Windows CI 成功、安装包可下载、Windows 实机烟测和资源测量完成**，才把 M3 标记为验收通过。现有代码是 M3 功能范围的候选实现；不在未验证前标记“发布完成”。

CI: https://github.com/Asigers/pi-pane/actions/workflows/windows.yml

