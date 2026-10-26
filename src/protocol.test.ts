import {describe, it, expect} from "vitest";
import {applyEvent, extractText, fromMessages, builtinCommand} from "./protocol";

describe("Pi JSONL client reducer", () => {
  it("reconstructs delta-only streaming and replaces with authoritative final", () => {
    let entries = applyEvent([], {type:"message_start", message:{role:"assistant",content:[]}});
    entries = applyEvent(entries, {type:"message_update", assistantMessageEvent:{type:"text_delta", contentIndex:0,delta:"Hello"}});
    entries = applyEvent(entries, {type:"message_update", assistantMessageEvent:{type:"text_delta",contentIndex:0,delta:"!"}});
    expect(entries[0].text).toBe("Hello!");
    entries = applyEvent(entries, {type:"message_end",message:{role:"assistant",content:[{type:"text",text:"Hello again"}]}});
    expect(entries[0].text).toBe("Hello again");
    entries = applyEvent(entries, {type:"message_start",message:{role:"assistant",content:[]}});
    expect(entries).toHaveLength(2);
  });
  it("tracks tools by toolCallId, including error status", () => {
    let entries = applyEvent([], {type:"tool_execution_start",toolCallId:"t1",toolName:"bash",args:{command:"pwd"}});
    entries = applyEvent(entries, {type:"tool_execution_end",toolCallId:"t1", isError:true,result:{content:[{type:"text",text:"failed"}]}});
    expect(entries[0].status).toBe("error");
    expect(entries[0].text).toBe("failed");
  });
  it("reads history and slash commands without submitting TUI commands to prompt", () => {
    expect(extractText([{type:"text",text:"A"},{type:"thinking",thinking:"hidden"}])).toBe("A");
    expect(fromMessages([{role:"user", content:"hey"},{role:"assistant",content:[{type:"text",text:"hi"}]}])).toHaveLength(2);
    expect(builtinCommand("/resume")).toEqual({type:"local_resume"});
    expect(builtinCommand("/unknown")).toBeNull();
  });
});
