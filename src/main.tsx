import {render} from "preact";
import {memo} from "preact/compat";
import {useEffect, useRef, useState} from "preact/hooks";
import {invoke} from "@tauri-apps/api/core";
import {listen, type UnlistenFn} from "@tauri-apps/api/event";
import {open} from "@tauri-apps/plugin-dialog";
import {applyEvent, builtinCommand, extractText, fromMessages, type Entry} from "./protocol";
import {renderMarkdown} from "./markdown";
import "./style.css";

type RpcModel = {provider: string; id: string; name?: string; contextWindow?: number};
type DialogRequest = {id:string; method:string; title?:string; message?:string;
  options?:string[]; placeholder?:string; prefill?:string; timeout?:number; [key:string]:any};
type Session = {path:string; name:string; modifiedMs:number};
type State = {model?:RpcModel; thinkingLevel?:string; isStreaming?:boolean; sessionFile?:string;
  pendingMessageCount?:number; sessionName?:string};

async function rpc(type: string, fields: Record<string, unknown> = {}): Promise<any> {
  return invoke("rpc_command", {payload: {type, ...fields}});
}

function Markdown({value}:{value:string}) {
  const html = renderMarkdown(value);
  return <div class="md" onClick={event => {
    const target = event.target as HTMLElement;
    const button = target.closest(".copy-code") as HTMLElement | null;
    if (!button) return;
    const code = button.closest(".code-block")?.querySelector("code")?.textContent ?? "";
    navigator.clipboard.writeText(code).catch(() => {});
    button.textContent = "已复制";
    setTimeout(() => { if (button.isConnected) button.textContent = "复制代码"; }, 1000);
  }} dangerouslySetInnerHTML={{__html:html}}/>;
}
const EntryView = memo(function EntryView({entry}:{entry: Entry}) {
  if (entry.role === "tool") return <details class="tool">
    <summary><span class={"tool-dot " + (entry.status ?? "")}/><span>{entry.tool ?? "tool"}</span>
      <small>{entry.status === "running" ? "运行中" : entry.status === "error" ? "失败" : "完成"}</small></summary>
    <pre>{entry.text.slice(0, 24_000)}{entry.text.length > 24_000 && "\n…已截断显示"}</pre>
  </details>;
  return <article class={"message " + entry.role}>
    <header><span>{entry.role === "user" ? "You" : "Pi"}</span>
      <button title="复制消息" onClick={() => navigator.clipboard.writeText(entry.text)}>复制</button></header>
    {entry.thinking && <details class="thinking"><summary>思考过程</summary><pre>{entry.thinking}</pre></details>}
    {entry.role === "assistant" ? <Markdown value={entry.text}/> : <div class="plain">{entry.text}</div>}
  </article>;
});

function ExtensionDialog({request, onResolve}:{request:DialogRequest;
  onResolve:(data:Record<string,unknown>)=>void}) {
  const [value, setValue] = useState(request.prefill ?? "");
  const [selected, setSelected] = useState(request.options?.[0] ?? "");
  return <div class="modal-layer" role="presentation">
    <div class="modal" role="dialog" aria-modal="true" aria-label={request.title ?? "Pi Extension 请求"}>
      <h2>{request.title ?? "Pi Extension 请求"}</h2>
      {request.message && <p>{request.message}</p>}
      {request.method === "select" && <select value={selected} onChange={e => setSelected(e.currentTarget.value)}>
        {(request.options ?? []).map(x => <option value={x} key={x}>{x}</option>)}</select>}
      {request.method === "input" && <input value={value} autoFocus placeholder={request.placeholder}
        onInput={e=>setValue(e.currentTarget.value)}/>}
      {request.method === "editor" && <textarea value={value} rows={9} autoFocus
        onInput={e=>setValue(e.currentTarget.value)}/>}
      <div class="modal-buttons">
        <button onClick={()=>onResolve({cancelled:true})}>取消</button>
        {request.method === "confirm" ? <>
          <button onClick={()=>onResolve({confirmed:false})}>否</button>
          <button class="primary" onClick={()=>onResolve({confirmed:true})}>确认</button>
        </> : <button class="primary" onClick={()=>onResolve({value: request.method === "select" ? selected : value})}>确定</button>}
      </div>
    </div>
  </div>;
}

function App() {
  const [cwd, setCwd] = useState(() => localStorage.getItem("pane.cwd") ?? "");
  const [piPath, setPiPath] = useState(() => localStorage.getItem("pane.path") ?? "");
  const [piVersion, setPiVersion] = useState("");
  const [connected, setConnected] = useState(false);
  const [working, setWorking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [state, setState] = useState<State>({});
  const [models, setModels] = useState<RpcModel[]>([]);
  const [levels, setLevels] = useState<string[]>([]);
  const [commands, setCommands] = useState<string[]>([]);
  const [sessionList, setSessionList] = useState<Session[] | null>(null);
  const [viewCount, setViewCount] = useState(100);
  const [contextPercent, setContextPercent] = useState<number | null>(null);
  const [uiDialog, setUiDialog] = useState<DialogRequest | null>(null);
  const [dialogQueue, setDialogQueue] = useState<DialogRequest[]>([]);
  const [statuses, setStatuses] = useState<Record<string,string>>({});
  const [widgets, setWidgets] = useState<Record<string,string[]>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef(true);
  const eventQueue = useRef<Record<string,any>[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestCwd = useRef(cwd);
  latestCwd.current = cwd;

  async function refreshState() {
    const current = await rpc("get_state");
    setState(current ?? {});
    setBusy(Boolean(current?.isStreaming));
    return current;
  }
  async function refreshHistory() {
    const data = await rpc("get_messages");
    setEntries(fromMessages(data?.messages ?? []));
    setViewCount(100);
  }
  async function refreshStats() {
    try {
      const data = await rpc("get_session_stats");
      setContextPercent(typeof data?.contextUsage?.percent === "number" ? data.contextUsage.percent : null);
    } catch { setContextPercent(null); }
  }
  async function refreshOptions() {
    const [ms,ls,cs] = await Promise.allSettled([
      rpc("get_available_models"), rpc("get_available_thinking_levels"), rpc("get_commands")]);
    if (ms.status === "fulfilled") setModels(ms.value?.models ?? []);
    if (ls.status === "fulfilled") setLevels(ls.value?.levels ?? []);
    if (cs.status === "fulfilled") setCommands((cs.value?.commands ?? []).map((x:any)=>x.name));
  }
  function enqueueEvent(raw:Record<string,any>) {
    eventQueue.current.push(raw);
    if (flushTimer.current) return;
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      const events = eventQueue.current.splice(0);
      setEntries(prev => events.reduce(applyEvent, prev));
    }, 40);
  }
  useEffect(() => {
    let disposed = false;
    const subs:UnlistenFn[] = [];
    async function subscribe() {
      for (const [name,handler] of [
        ["pi-event", (data:any) => {
          if (data.type === "extension_ui_request") {
            switch (data.method) {
              case "select": case "confirm": case "input": case "editor":
                setDialogQueue(prev=>[...prev,data as DialogRequest]); break;
              case "notify": setNotice(String(data.message ?? "")); break;
              case "setStatus": setStatuses(prev=> {
                const next={...prev}; if (data.statusText) next[data.statusKey] = data.statusText;
                else delete next[data.statusKey]; return next;
              }); break;
              case "setWidget": setWidgets(prev=>{
                const next={...prev}; if (data.widgetLines) next[data.widgetKey] = data.widgetLines;
                else delete next[data.widgetKey]; return next;
              }); break;
              case "set_editor_text": setDraft(data.text ?? ""); break;
              case "setTitle": document.title=String(data.title ?? "Pi Pane"); break;
            }
            return;
          }
          if (data.type === "agent_start") setBusy(true);
          if (data.type === "agent_settled") {
            setBusy(false);
            void refreshState().catch(()=>{});
            void refreshStats();
          }
          if (data.type === "message_start" || data.type === "message_update" ||
              data.type === "message_end" || data.type.startsWith("tool_execution_")) enqueueEvent(data);
          if (data.type === "extension_error") setNotice(data.error ?? "扩展执行失败");
          if (data.type === "auto_retry_start") setNotice("正在自动重试…");
        }],
        ["pi-exit", () => {setConnected(false);setBusy(false);setNotice("Pi RPC 已退出，请重新连接");}],
        ["pi-error", (error:any) => setNotice(String(error))],
        ["pi-diagnostic", (line:any) => setNotice("Pi: " + String(line))],
      ] as const) {
        const unlisten=await listen(name, e=>handler(e.payload));
        if(disposed) unlisten(); else subs.push(unlisten);
      }
    }
    void subscribe();
    void invoke<string>("detect_pi").then(setPiVersion).catch(()=>{});
    return ()=>{disposed=true; subs.forEach(x=>x()); if(flushTimer.current) clearTimeout(flushTimer.current);};
  }, []);
  useEffect(() => {
    if (!uiDialog?.timeout) return;
    const timer = setTimeout(() => setUiDialog(current => current?.id === uiDialog.id ? null : current), uiDialog.timeout);
    return () => clearTimeout(timer);
  }, [uiDialog]);
  useEffect(() => {
    if (!uiDialog && dialogQueue.length) {
      setUiDialog(dialogQueue[0]); setDialogQueue(prev=>prev.slice(1));
    }
  }, [uiDialog,dialogQueue]);
  useEffect(() => {
    const element=scrollRef.current;
    if (element && bottomRef.current) element.scrollTop=element.scrollHeight;
  }, [entries]);

  const run = async (fn:()=>Promise<void>) => {
    try {setNotice(""); await fn();}
    catch (e) {setNotice(String(e));}
  };
  async function connect() {
    await run(async ()=>{
      if(!cwd.trim()) throw Error("请先选择工作目录");
      setWorking(true);
      try {
        // Listener registration is initiated at mount; Pi is not started until the UI is ready.
        await invoke("start_pi",{cwd,executable:piPath,resumeLast:true});
        setConnected(true);
        localStorage.setItem("pane.cwd",cwd);
        localStorage.setItem("pane.path",piPath);
        await Promise.all([refreshState(),refreshHistory(),refreshOptions(),refreshStats()]);
      } catch(e) {setConnected(false);throw e;} finally {setWorking(false);}
    });
  }
  async function chooseDirectory() {
    const selected = await open({directory:true,multiple:false,title:"选择 Pi 工作目录"});
    if(typeof selected === "string") setCwd(selected);
  }
  async function disconnect() {
    await run(async()=>{await invoke("stop_pi");setConnected(false);setBusy(false);});
  }
  async function showSessions() {
    const items=await invoke<Session[]>("list_sessions",{cwd:latestCwd.current});
    setSessionList(items);
  }
  async function onCommand(command:string) {
    const special=builtinCommand(command);
    if(special) {
      if(special.type === "local_resume") return showSessions();
      if(special.type === "local_models") {document.getElementById("model-picker")?.focus(); return;}
      if(special.type === "local_thinking") {document.getElementById("level-picker")?.focus(); return;}
      if(special.type === "local_help") {setNotice("内置命令：/new /resume /model /thinking /session /compact /clone /export /name /abort /clear");return;}
      const result=await rpc(special.type,special);
      if(special.type === "new_session" || special.type === "clone") {
        if(!result?.cancelled) {await refreshHistory(); await refreshState();}
      } else if(special.type === "get_session_stats") {
        setNotice("上下文：" + (result?.contextUsage?.percent ?? "未知") + "%；消息：" + (result?.totalMessages ?? "未知"));
      } else if(special.type === "export_html") {
        setNotice("导出到：" + (result?.path ?? "未知路径"));
      } else {
        await refreshState(); await refreshStats();
      }
      return;
    }
    const commandName=command.trim().slice(1).split(/\s+/)[0];
    if(!commands.includes(commandName)) throw Error("未找到此命令（Pi 内置 TUI 命令不可直接传给 RPC）");
    await rpc("prompt",{message:command,...(busy ? {streamingBehavior:"followUp"} : {})});
  }
  async function send() {
    const text=draft.trim();
    if(!text) return;
    await run(async ()=>{
      if(text.startsWith("/")) await onCommand(text);
      else await rpc("prompt",{message:text,...(busy ? {streamingBehavior:"followUp"} : {})});
      setDraft("");
    });
  }
  async function changeSession(path:string) {
    await run(async()=>{
      const r=await rpc("switch_session",{sessionPath:path});
      if(!r?.cancelled) {await refreshHistory(); await refreshState(); await refreshStats();}
      setSessionList(null);
    });
  }
  const visible=entries.slice(-viewCount);
  return <div class="shell">
    <header class="topbar">
      <div class="brand"><span class="mark">π</span><strong>Pi Pane</strong></div>
      {connected ? <>
        <button class="directory" title={cwd} onClick={()=>{void disconnect();}}>{cwd.split(/[\\/]/).pop() || cwd} <span>切换</span></button>
        <nav>
          <button onClick={()=>void run(async()=>{await rpc("new_session");await refreshHistory();await refreshState();})}>新会话</button>
          <button onClick={()=>void run(showSessions)}>恢复会话</button>
          <button onClick={()=>void run(async()=>{
            if(busy) throw Error("请先停止当前任务再打开原生 TUI");
            await disconnect();
            setNotice("RPC 已停止。请在终端使用 pi --continue 打开最近会话，避免双进程同时写入。");
          })}>TUI 回退</button>
        </nav>
      </> : <span class="subtitle">你的本地 Pi，换一个窗口</span>}
    </header>
    {!connected ? <main class="welcome">
      <div class="welcome-card">
        <span class="hero-mark">π</span><h1>连接本地 Pi</h1>
        <p>复用已安装 Pi 的模型、工具、扩展及原生会话。不需要额外的 Agent 服务。</p>
        <label>工作目录</label><div class="row"><input value={cwd} onInput={e=>setCwd(e.currentTarget.value)}
          placeholder="C:\work\your-project"/><button onClick={()=>void chooseDirectory()}>浏览…</button></div>
        <label>Pi 可执行文件（可选）</label><input value={piPath} onInput={e=>setPiPath(e.currentTarget.value)}
          placeholder="留空自动从 PATH 寻找 pi"/>
        <small>{piVersion ? "检测到 Pi: " + piVersion : "未自动检测到 Pi；可指定完整路径"}</small>
        <button class="primary full" disabled={working || !cwd.trim()} onClick={()=>void connect()}>
          {working ? "正在连接…" : "打开 Pi"}</button>
      </div>
    </main> : <>
      <main class="conversation" ref={scrollRef} onScroll={e=>{
        const el=e.currentTarget;bottomRef.current=el.scrollHeight-el.scrollTop-el.clientHeight<120;
      }}>
        <div class="conversation-inner">
          {entries.length===0 && <div class="empty">在下方输入任务，Pi 将使用当前目录运行。</div>}
          {entries.length>viewCount && <button class="more" onClick={()=>setViewCount(x=>x+150)}>
            加载更早的 {Math.min(entries.length-viewCount,150)} 条消息</button>}
          {visible.map(entry=><EntryView entry={entry} key={entry.id}/>)}
          {busy && <div class="working-indicator"><span class="pulse"/> Pi 正在运行…</div>}
        </div>
      </main>
      <div class="bottom">
        {Object.entries(widgets).map(([key,lines])=><div key={key} class="widget">{lines.join("\n")}</div>)}
        {notice && <div class="notice" role="status"><span>{notice}</span><button onClick={()=>setNotice("")}>×</button></div>}
        <div class="composer">
          <textarea value={draft} placeholder="输入消息、/ 命令；Enter 发送，Shift+Enter 换行"
            onInput={e=>setDraft(e.currentTarget.value)}
            onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();void send();}
              if(e.key==="Escape" && busy) void run(async()=>{await rpc("clear_queue");await rpc("abort");});}}
            rows={3}/>
          <div class="composer-actions">
            <span>{busy ? "新消息将排队执行" : "就绪"}</span>
            {busy && <button onClick={()=>void run(async()=>{await rpc("clear_queue");await rpc("abort");})}>停止</button>}
            <button class="primary" disabled={!draft.trim()} onClick={()=>void send()}>发送</button>
          </div>
        </div>
        <footer class="statusbar">
          <label>模型
            <select id="model-picker" value={state.model ? state.model.provider+"/"+state.model.id : ""}
              onChange={e=>void run(async()=>{
                const model=models.find(x=>x.provider+"/"+x.id===e.currentTarget.value);
                if(!model)return;
                await rpc("set_model",{provider:model.provider,modelId:model.id});
                await refreshState();await refreshOptions();await refreshStats();
              })}>
              {!state.model && <option value="">未选择</option>}
              {state.model && !models.some(x=>x.provider===state.model?.provider && x.id===state.model?.id) &&
                <option value={state.model.provider+"/"+state.model.id}>{state.model.provider}/{state.model.id}</option>}
              {models.map(x=><option value={x.provider+"/"+x.id} key={x.provider+"/"+x.id}>
                {x.provider}/{x.name ?? x.id}</option>)}
            </select>
          </label>
          <label>思考
            <select id="level-picker" value={state.thinkingLevel ?? "off"} onChange={e=>void run(async()=>{
              await rpc("set_thinking_level",{level:e.currentTarget.value});await refreshState();
            })}>{(levels.length ? levels : [state.thinkingLevel ?? "off"]).map(x=>
              <option value={x} key={x}>{x}</option>)}</select>
          </label>
          <span>上下文 {contextPercent === null ? "—" : contextPercent.toFixed(1)+"%"}</span>
          {Object.entries(statuses).slice(0,2).map(([key,val])=><span title={key} key={key}>{val}</span>)}
          <span class="connection"><i/>{busy ? "运行中" : "已连接"}</span>
        </footer>
      </div>
    </>}
    {sessionList && <div class="modal-layer"><div class="modal sessions" role="dialog" aria-modal="true">
      <h2>恢复会话（当前工作目录）</h2>
      <div class="session-items">{sessionList.length ? sessionList.map(x=>
        <button key={x.path} title={x.path} onClick={()=>void changeSession(x.path)}>
          <strong>{x.name}</strong><small>{new Date(x.modifiedMs).toLocaleString()}</small>
        </button>) : <p>此目录未发现会话。自定义 Pi sessionDir 尚需手动指定。</p>}</div>
      <div class="modal-buttons"><button onClick={()=>setSessionList(null)}>关闭</button></div>
    </div></div>}
    {uiDialog && <ExtensionDialog request={uiDialog} key={uiDialog.id} onResolve={data=>{
      void run(async()=>{await invoke("extension_response",{payload:{type:"extension_ui_response",id:uiDialog.id,...data}});});
      setUiDialog(null);
    }}/>}
  </div>;
}
render(<App/>,document.getElementById("app")!);
