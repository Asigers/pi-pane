# Windows 使用与开发

## 先决条件

- Windows 10/11 x64
- 系统 WebView2 Runtime（缺失时 NSIS 安装程序会提示或尝试下载安装）
- 本地已安装并能在命令提示符中执行的 `pi --version`
- 本地 Pi 已配置模型/Provider 凭证；Pane 不额外配置模型
- 开发者额外需要 Node.js 22、Rust stable（MSVC）、Visual Studio C++ Build Tools、Windows SDK

## 安装 Windows 程序

1. 打开 [Windows CI](https://github.com/Asigers/pi-pane/actions/workflows/windows.yml)，进入**成功完成**的最新 main 构建。
2. 从 Artifacts 下载 `pi-pane-windows-x64-unsigned`；解压后运行 NSIS `*-setup.exe`。
3. Windows SmartScreen 可能提示未知发布者：当前构建**未签名**；只有在核对 GitHub 仓库和构建工作流来源后才继续。
4. 打开 Pi Pane，选择工作目录；可执行文件路径默认留空（从 PATH 探测本地 `pi.cmd`），如未找到则提供 Pi 的明确路径。
5. 点击“打开 Pi”开始使用。首次使用本地 Pi 时可能触发其原生项目授权或其他资源初始化；依赖本地 Pi 的版本和配置。

## 开发

```powershell
git clone https://github.com/Asigers/pi-pane.git
cd pi-pane
npm install
npm test
npm run check
npm run dev
```

生成 Windows 安装包：

```powershell
npm run build:windows
```

NSIS 产物在 `src-tauri/target/release/bundle/nsis/`。如果系统缺少 WebView2，Windows 发行配置使用下载引导程序模式。

## 原生 TUI 回退

点击“ TUI 回退”会先停止 Pane 连接的 RPC Pi，再提醒你在原工作目录执行：

```powershell
pi --continue
```

这里不是嵌入终端，不保证自动打开终端窗口；这么做是为了避免两个进程同时写同一个 Pi session JSONL。

## 故障排除

- 无法连接：先在**同一个 Windows 用户**的命令提示符中验证 `pi --version` 和 `pi --mode rpc`。注意 `pi --mode rpc` 会等待 JSONL stdin，不会出现聊天 TUI。
- 含特殊字符的 pi.cmd 路径：Rust 桥接会拒绝部分 cmd 元字符，以防命令注入。请使用普通路径安装或真实可执行入口。
- 恢复历史会话列表为空：当前仅扫描默认当前项目的会话目录及 `PI_CODING_AGENT_SESSION_DIR` 环境变量；如果 Pi 的 settings.json 定义了独立 sessionDir，先在 TUI 中恢复。
- 自定义 TUI Footer/Widget 不出现：`ctx.ui.custom()` 和某些 `setFooter` 组件不受 RPC 支持；这是 Pi 官方协议限制。
- Extension 请求弹窗超时：有些请求由 Pi 设置超时；超过期限后 Pi 会自动取消，UI 的迟到回复不会重新授权。
- 项目退出后有 Node 子进程：反馈 Windows/Pi 版本、安装方式及进程树。Pane 在正常关闭窗口时等待 RPC 退出，超时后执行 Windows 进程树清理，强制结束 Pane 则无法保证 Pi 数据已全部写盘。

## 性能测试

可运行 `powershell -ExecutionPolicy Bypass -File scripts/measure.ps1` 生成机器级 WebView2 + Pane 工作集数据。**此脚本可能包含其他 WebView2 应用，结果是粗略上界**；发布前需用 Process Explorer 识别 Pane 的 WebView2 子进程并重新归因。


## Windows 启动后闪现终端，又回到工作目录页面（2026-10-26 修复）

旧版存在三处启动缺陷：

1. GUI 下使用 cmd.exe 运行 pi.cmd，没有设置 CREATE_NO_WINDOW，导致控制台闪现；
2. cmd.exe 的 /C 命令行未把 --continue 保存在同一条命令字符串中，存在 Windows 引号与参数解析风险；
3. 仅判断进程创建成功，不做 RPC get_state 握手；进程退出又回到工作目录页面，且诊断消息仅在聊天页显示。

修复版的「打开 Pi」必须先通过本机 Pi 的 get_state 握手，才显示聊天界面。若启动失败，**工作目录选择页面下方会保留详细错误与复制错误按钮**，不会静默返回。检测 Pi 版本、启动 Pi 以及停止进程时均避免弹出新的控制台窗口。

排查步骤（在 Windows CMD 或 PowerShell 中执行，避免粘贴任何 API Key）：

```powershell
where.exe pi
pi --version
pi --mode rpc --no-session
```

最后一条进入 RPC 模式后，终端会等待 JSONL 命令。可输入：

```json
{"id":"test","type":"get_state"}
```

出现 `success:true` 的 `response` 表示 CLI RPC 可以启动；然后按 Ctrl+C 退出测试。
若 `where.exe pi` 无输出或程序不能正常启动，请在 Pi Pane 填写由 `where.exe pi` 找到的 `pi.cmd` 真实路径；不支持直接填写 PowerShell 的别名/函数名。

当前回归测试：CI 在 Windows Runner 安装官方 `@earendil-works/pi-coding-agent@1.4.0`，不仅通过独立 Node RPC 冒烟，还用 **Pi Pane 实际 Rust cmd.exe 启动器** 执行 `--mode rpc --continue` 的握手测试。发布版还需确认对应工作流全部成功。
