export type JsonRecord = Record<string, any>;
export interface Entry {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  thinking?: string;
  tool?: string;
  status?: "running" | "success" | "error";
}
const limit = (value: string, cap = 120_000) => value.slice(0, cap);

export function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text).join("\n");
}
export function extractThinking(content: any): string {
  if (!Array.isArray(content)) return "";
  return content.filter((part: any) => part?.type === "thinking")
    .map((part: any) => part.thinking ?? "").join("\n");
}
export function fromMessages(messages: any[]): Entry[] {
  return messages.flatMap((message, index) => {
    if (message.role === "user" || message.role === "assistant") {
      return [{id: "history-" + index, role: message.role, text: extractText(message.content),
        thinking: extractThinking(message.content)} as Entry];
    }
    if (message.role === "toolResult") {
      return [{id: "history-tool-" + index, role: "tool", tool: message.toolName ?? "tool",
        text: extractText(message.content), status: message.isError ? "error" : "success"} as Entry];
    }
    return [];
  });
}

let sequence = 0;
const fresh = () => "live-" + (++sequence);

/** Pi emits delta-only message_update. message_end is authoritative. */
export function applyEvent(entries: Entry[], event: JsonRecord): Entry[] {
  const list = entries.slice();
  const lastAssistant = () => {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === "assistant" && list[i].id.startsWith("live-")) return i;
    }
    return -1;
  };
  if (event.type === "message_start" && ["user", "assistant"].includes(event.message?.role)) {
    list.push({id: fresh(), role: event.message.role, text: extractText(event.message.content)});
  }
  if (event.type === "message_update") {
    const part = event.assistantMessageEvent ?? {};
    let index = lastAssistant();
    if (index < 0) {
      list.push({id: fresh(), role: "assistant", text: ""});
      index = list.length - 1;
    }
    const existing = list[index];
    if (part.type === "text_delta") list[index] = {...existing, text: limit(existing.text + (part.delta ?? ""))};
    if (part.type === "thinking_delta") list[index] = {...existing, thinking: limit((existing.thinking ?? "") + (part.delta ?? ""))};
    if (part.type === "text_end" && typeof part.content === "string") list[index] = {...existing, text: part.content};
    if (part.type === "thinking_end" && typeof part.content === "string") list[index] = {...existing, thinking: part.content};
  }
  if (event.type === "message_end" && ["user", "assistant"].includes(event.message?.role)) {
    const role = event.message.role as "user" | "assistant";
    const index = list.findLastIndex(x => x.role === role && x.id.startsWith("live-"));
    const entry: Entry = {id: index >= 0 ? list[index].id : fresh(), role,
      text: extractText(event.message.content), thinking: extractThinking(event.message.content)};
    if (index < 0) list.push(entry);
    else list[index] = entry;
    // Finalize id so further messages don't overwrite earlier turns.
    list[index >= 0 ? index : list.length - 1] = {...entry, id: "done-" + entry.id};
  }
  if (event.type === "tool_execution_start") {
    list.push({id: "tool-" + event.toolCallId, role: "tool", tool: event.toolName,
      text: JSON.stringify(event.args ?? {}, null, 2), status: "running"});
  }
  if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
    const index = list.findIndex(x => x.id === "tool-" + event.toolCallId);
    if (index !== -1) {
      const value = event.type === "tool_execution_end" ? event.result : event.partialResult;
      list[index] = {...list[index], text: limit(extractText(value?.content) || JSON.stringify(value ?? {}, null, 2), 24_000),
        status: event.type === "tool_execution_end" ? (event.isError ? "error" : "success") : "running"};
    }
  }
  return list;
}

export interface SlashCommand {type: string; [key: string]: any}
export function builtinCommand(input: string): SlashCommand | null {
  const [name, ...rest] = input.trim().split(/\s+/);
  const value = rest.join(" ");
  switch (name?.toLowerCase()) {
    case "/new": return {type: "new_session"};
    case "/model": return value ? {type: "local_models"} : {type: "local_models"};
    case "/thinking": return {type: "local_thinking"};
    case "/resume": return {type: "local_resume"};
    case "/session": return {type: "get_session_stats"};
    case "/compact": return {type: "compact", ...(value ? {customInstructions: value} : {})};
    case "/clone": return {type: "clone"};
    case "/export": return {type: "export_html"};
    case "/abort": return {type: "abort"};
    case "/clear": return {type: "clear_queue"};
    case "/name": return value ? {type: "set_session_name", name: value} : {type: "local_help"};
    case "/help": return {type: "local_help"};
    default: return null;
  }
}
