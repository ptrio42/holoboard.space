import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { spawn } from 'node:child_process';
import { createAccountClient, validateSignedEvent } from '@holoboard/accounts-client';

// Loopback-only acceptance helper. Prints fixed results, never messages, tokens or keys.
const [configPath, mode='standalone'] = process.argv.slice(2);
let child;
try {
  const config=JSON.parse(await readFile(configPath,'utf8'));
  const base=new URL(config.baseURL);
  if(base.protocol!=='https:' || base.hostname!=='127.0.0.1' || !['standalone','embedded'].includes(mode) || !config.developmentCapturePath) throw new Error();
  const ca=await readFile(config.tls.certPath);
  const args=mode==='standalone'?['apps/service/dist/main.js','serve',configPath]:['examples/embedded.mjs',configPath];
  child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',()=>{});
  for(let i=0;i<200&&!output.includes('LISTENING');i++) {if(child.exitCode!==null)throw new Error();await new Promise(r=>setTimeout(r,25));}
  assert.ok(output.includes('LISTENING'));
  const cookies=new Map();
  const transport=async operation=>new Promise((resolve,reject)=>{
    const target=new URL(operation.url);if(target.origin!==base.origin)throw new Error();
    const req=request(target,{ca,servername:'localhost',agent:false,method:operation.method,headers:{origin:base.origin,...(operation.body?{'content-type':'application/json'}:{}),cookie:[...cookies].map(([name,value])=>`${name}=${value}`).join('; ')}},response=>{
      const chunks=[];let bytes=0;
      response.on('data',chunk=>{bytes+=chunk.length;if(bytes>operation.maxResponseBytes){req.destroy();reject(new Error());}else chunks.push(chunk);});response.on('error',reject);
      response.on('end',()=>{
        for(const value of response.headers['set-cookie']??[]) {const pair=value.split(';')[0],equal=pair.indexOf('=');const name=pair.slice(0,equal),data=pair.slice(equal+1);if(!data||/max-age=0/i.test(value))cookies.delete(name);else cookies.set(name,data);}
        resolve({status:response.statusCode,body:Buffer.concat(chunks).toString('utf8')});
      });
    });
    req.setTimeout(operation.timeoutMs,()=>req.destroy(new Error()));req.on('error',reject);if(operation.body)req.write(operation.body);req.end();
  });
  const client=createAccountClient({baseURL:base.origin,transport});
  const email=`walkthrough-${mode}@example.test`,password='local fixture password 12345';
  await client.register({email,password,name:'Local reader'});
  async function message(kind,previous='') {
    for(let i=0;i<200;i++) {
      try {const messages=(await readFile(config.developmentCapturePath,'utf8')).trim().split('\n').map(x=>JSON.parse(x));const found=messages.findLast(m=>m.email===email&&m.kind===kind&&m.token!==previous);if(found)return found;} catch {}
      await new Promise(r=>setTimeout(r,25));
    }
    throw new Error();
  }
  const verification=await message('verification');await client.verifyEmail(verification.token);
  assert.equal(await client.getSession(),null);await client.login(email,password);
  const publicKey=await client.signer.getPublicKey();
  const template={kind:1,created_at:1700000000,content:'Local unpublished fixture',tags:[['t','local'],['t','local']]};
  const event=await client.signer.signEvent(template);validateSignedEvent(event,template,publicKey);
  const exported=await client.exportKey(password);assert.equal(exported.publicKey,publicKey);
  await client.requestRecovery(email);const recovery=await message('password-reset');
  await client.resetPassword(recovery.token,'changed fixture password 12345');await assert.rejects(client.login(email,password));
  await client.login(email,'changed fixture password 12345');assert.equal(await client.signer.getPublicKey(),publicKey);
  await client.logout();assert.equal(await client.getSession(),null);
  child.kill('SIGTERM');await new Promise((resolve,reject)=>{child.once('exit',code=>code===0?resolve():reject(new Error()));});assert.ok(output.includes('ACCOUNT_STOPPED'));
  process.stdout.write(`ACCOUNT_${mode.toUpperCase()}_CHECK_PASSED\n`);
} catch {
  process.stderr.write('ACCOUNT_LOCAL_CHECK_FAILED\n');process.exitCode=1;
} finally {
  if(child&&child.exitCode===null){child.kill('SIGTERM');const timeout=setTimeout(()=>child.kill('SIGKILL'),2000);timeout.unref();}
}
