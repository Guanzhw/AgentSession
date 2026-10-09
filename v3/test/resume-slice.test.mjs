import { freeFetchSafePort } from './fetch-safe-port.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
const repo = path.resolve(import.meta.dirname, '../..');
const binary = process.env.AGENTSESSION_V3_BIN || path.join(repo, 'v3/target/debug', process.platform === 'win32' ? 'agentsession-v3.exe' : 'agentsession-v3');
const id = '019f8a00-0000-7000-8000-000000000001';
async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(repo, 'tmp/v3-resume-'));
  for (const name of ['pi/sessions/project','codex','claude','dsh']) await mkdir(path.join(dir,name), {recursive:true});
  const source = (await readFile(path.join(repo,'test/fixtures/pi-v3-current.jsonl'),'utf8'));
  await writeFile(path.join(dir, 'pi/sessions/project/current.jsonl'),source);
  const marker = path.join(dir,'launched.json');
  const helper = path.join(dir,'helper.cjs');
  await writeFile(helper, `require('fs').writeFileSync(process.argv[2],JSON.stringify({args:process.argv.slice(3),cwd:process.cwd(),pid:process.pid}));`);
  const override = typeof options.config === 'function' ? await options.config({dir,helper,marker}) : options.config;
  const config = {resumeCommands:{pi:{executable:process.execPath,args:[helper,marker,'{sessionId}','{projectPath}','literal $HOME; & echo injected'],cwd:dir}},resumeShell:{executable:'pwsh.exe',args:['-NoLogo','-NoProfile']},...override};
  const file = path.join(dir,'config.json'); await writeFile(file,JSON.stringify(config));
  const port = await freeFetchSafePort();
  const args=['--config',file,'serve','--port',String(port),'--pi-dir',path.join(dir,'pi'),'--codex-dir',path.join(dir,'codex'),'--claude-dir',path.join(dir,'claude'),'--dsh-dir',path.join(dir,'dsh'),'--opencode-db',path.join(dir,'absent.db'),'--meta-dir',path.join(dir,'meta'),'--index-dir',path.join(dir,'index'),'--cache-dir',path.join(dir,'cache'),...(options.disabled?['--disable-terminal-launch']:[])];
  const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','ignore','pipe']}); let stderr=''; child.stderr.on('data',c=>stderr+=c);
  t.after(async()=>{if(child.exitCode===null && child.signalCode===null){const closed=once(child,'close'); child.kill(); await closed;} await rm(dir,{recursive:true,force:true,maxRetries:30,retryDelay:100});});
  const base=`http://127.0.0.1:${port}`;
  const started = performance.now();
  let lastProbe = 'not attempted';
  const readinessFailure = () => `AgentSession 3.0 HTTP readiness failed after ${Math.round(performance.now() - started)}ms; ` +
    `exitCode=${child.exitCode}, signalCode=${child.signalCode}; last probe: ${lastProbe}; stderr: ${stderr.trim() || '(none)'}`;
  for(let i=0;i<300;i++){
    if(child.exitCode!==null || child.signalCode!==null) throw Error(readinessFailure());
    try {
      const response = await fetch(base+'/api/providers');
      if(response.ok) return {base,dir,marker,helper};
      lastProbe = `HTTP ${response.status}`;
    } catch(error) {
      lastProbe = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    await new Promise(r=>setTimeout(r,100));
  }
  throw Error(readinessFailure());
}
const route=(base)=>`${base}/api/v3/resume/pi/${id}`;
const launch=(base,headers={origin:base,'content-type':'application/json'},body='{}')=>fetch(route(base),{method:'POST',headers,body});
test('resume enforces startup opt-out and same-origin JSON boundary',async t=>{
 const {base}=await setup(t,{disabled:true});
 const info=await (await fetch(route(base))).json(); assert.equal(info.allowTerminalLaunch,false);
 assert.equal((await launch(base)).status,403);
 assert.equal((await launch(base,{'content-type':'application/json'})).status,403);
 assert.equal((await launch(base,{origin:'http://evil.example','content-type':'application/json'})).status,403);
 assert.equal((await launch(base,{origin:base,'content-type':'text/plain'})).status,415);
});
test('resume launches a harmless descendant with exact args and cwd',{skip:process.platform!=='win32'},async t=>{
 const {base,dir,marker}=await setup(t);
 const info=await (await fetch(route(base))).json(); assert.equal(info.available,true); assert.equal(info.command.executable,process.execPath);
 assert.equal((await launch(base,undefined,'{"executable":"evil"}')).status,422);
 const response=await launch(base); assert.equal(response.status,200,await response.text());
 let result; for(let i=0;i<50;i++){try{result=JSON.parse(await readFile(marker,'utf8'));break;}catch{} await new Promise(r=>setTimeout(r,100));}
 assert.ok(result,'actual descendant writes evidence'); assert.deepEqual(result.args,[id,dir,'literal $HOME; & echo injected']); assert.equal(result.cwd,dir); assert.ok(result.pid>0);
});
test('resume preserves quotes, empty arguments and shell metacharacters for an executable',{skip:process.platform!=='win32'},async t=>{
 const argumentsToPreserve=['two words','embedded"quote','','safe" & echo INJECTION_PROBE & rem "','%USERNAME%','a;b|c^d'];
 const {base,dir,marker}=await setup(t,{config:({dir,helper,marker})=>({resumeCommands:{pi:{executable:process.execPath,args:[helper,marker,...argumentsToPreserve],cwd:dir}}})});
 const response=await launch(base); assert.equal(response.status,200,await response.text());
 let result; for(let i=0;i<50;i++){try{result=JSON.parse(await readFile(marker,'utf8'));break;}catch{} await new Promise(r=>setTimeout(r,100));}
 assert.ok(result,'actual descendant writes evidence'); assert.deepEqual(result.args,argumentsToPreserve); assert.equal(result.cwd,dir);
});
test('resume fails closed for a batch shim and does not execute an injection sentinel',{skip:process.platform!=='win32'},async t=>{
 let sentinel;
 const {base,marker}=await setup(t,{config:async ({dir,helper,marker})=>{
   sentinel=path.join(dir,'injection-probe.txt');
   const shim=path.join(dir,'resume.cmd');
   await writeFile(shim,`@echo off\r\n"${process.execPath}" "${helper}" "${marker}" %*\r\n`);
   return {resumeCommands:{pi:{executable:shim,args:['safe" & echo INJECTION_PROBE > "'+sentinel+'" & rem "'],cwd:dir}}};
 }});
 const info=await (await fetch(route(base))).json(); assert.equal(info.available,false); assert.match(info.diagnostic,/batch|\.cmd|\.bat/i);
 assert.equal((await launch(base)).status,409);
 await assert.rejects(access(marker)); await assert.rejects(access(sentinel));
});
test('resume rejects Windows PowerShell before launching an executable',{skip:process.platform!=='win32'},async t=>{
 const {base,marker}=await setup(t,{config:{resumeShell:{executable:'powershell.exe',args:['-NoLogo','-NoProfile']}}});
 const info=await (await fetch(route(base))).json(); assert.equal(info.available,false); assert.match(info.diagnostic,/PowerShell 7|pwsh/i);
 const response=await launch(base); assert.equal(response.status,409); assert.match((await response.json()).error.message,/PowerShell 7|pwsh/i);
 await assert.rejects(access(marker));
});
test('resume reports invalid directory and missing executable explicitly',async t=>{
 const {base}=await setup(t,{config:{resumeCommands:{pi:{executable:'agentsession-does-not-exist',args:[],cwd:'relative'}}}});
 const info=await (await fetch(route(base))).json(); assert.equal(info.available,false); assert.match(info.diagnostic,/absolute existing directory/);
 assert.equal((await launch(base)).status,409);
});

test('resume configuration disable and missing executable remain explicit',async t=>{
 const {base}=await setup(t,{config:{resumeCommands:{pi:false}}});
 const info=await (await fetch(route(base))).json(); assert.equal(info.available,false); assert.match(info.diagnostic,/disabled or unavailable/);
 assert.equal((await launch(base)).status,409);
 assert.equal((await fetch(`${base}/api/pi/session/${id}/resume`,{method:'POST',headers:{origin:base,'content-type':'application/json'},body:'{}'})).status,409);
});
test('resume refuses an unavailable executable without spawning',async t=>{
 const {base,marker}=await setup(t,{config:{resumeCommands:{pi:{executable:'agentsession-absent-command',args:[],cwd:repo}}}});
 const diagnostic=process.platform==='win32'?/Executable .*not found/:/supported on Windows only/;
 const info=await (await fetch(route(base))).json(); assert.equal(info.available,false); assert.match(info.diagnostic,diagnostic);
 assert.equal((await launch(base)).status,409);
 assert.equal((await fetch(`${base}/api/v3/resume/pi/nonexistent`)).status,404);
 await assert.rejects(access(marker));
});
test('resume rejects an unavailable shell and cross-origin requests before launch',async t=>{
 const {base,marker}=await setup(t,{config:{resumeShell:{executable:'agentsession-missing-shell',args:[]}}});
 const diagnostic=process.platform==='win32'?/Shell .*was not found/:/supported on Windows only/;
 const info=await (await fetch(route(base))).json(); assert.equal(info.available,false); assert.match(info.diagnostic,diagnostic);
 assert.equal((await launch(base,{'content-type':'application/json'})).status,403);
 assert.equal((await launch(base,{origin:'http://evil.example','content-type':'application/json'})).status,403);
 const response=await launch(base); assert.equal(response.status,409); assert.match((await response.json()).error.message,diagnostic);
 await assert.rejects(access(marker));
});
