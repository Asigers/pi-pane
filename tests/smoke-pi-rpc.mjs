// A dependency-free Windows smoke test of an actual installed Pi CLI RPC process.
// No provider credentials, prompts, tools, or network model requests required.
import {spawn} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";

const home=mkdtempSync(path.join(os.tmpdir(),"pane-rpc-smoke-"));
const child=spawn("cmd.exe", ["/D","/C","pi --mode rpc --no-session"], {
  windowsHide:true, cwd:process.cwd(),
  env:{...process.env, PI_CODING_AGENT_DIR:home, PI_OFFLINE:"1"},
  stdio:["pipe","pipe","pipe"],
});
let buffer=Buffer.alloc(0), stderr="", settled=false;
const timer=setTimeout(()=>finish(new Error("Pi RPC get_state timed out after 45 seconds: "+stderr.slice(-1000))),45_000);
function finish(error=null) {
  if(settled)return;
  settled=true;
  clearTimeout(timer);
  child.stdin.end();
  child.kill();
  rmSync(home,{recursive:true,force:true});
  if(error){console.error(error); process.exitCode=1;}
  else console.log("Pi CLI RPC smoke passed");
}
child.on("error",finish);
child.on("exit",(code)=>{
  if(!settled)finish(new Error("Pi RPC exited before get_state response (code "+code+"): "+stderr.slice(-1000)));
});
child.stderr.on("data",chunk=>{stderr=(stderr+chunk.toString("utf8")).slice(-2000);});
child.stdout.on("data",chunk=>{
  if(settled)return;
  buffer=Buffer.concat([buffer,chunk]);
  let index;
  while((index=buffer.indexOf(10))!==-1){
    const line=buffer.subarray(0,index);
    buffer=buffer.subarray(index+1);
    if(!line.length)continue;
    let record;
    try{record=JSON.parse(line.toString("utf8"));}
    catch(e){return finish(new Error("Pi returned non-JSONL stdout: "+e));}
    if(record.type==="response"&&record.id==="pi-pane-smoke"){
      if(record.success!==true||typeof record.data?.sessionId!=="string"){
        return finish(new Error("Invalid get_state response: "+JSON.stringify(record)));
      }
      return finish();
    }
  }
});
child.stdin.write(JSON.stringify({id:"pi-pane-smoke",type:"get_state"})+"\n");
