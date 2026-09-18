import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { isPublicIPv4, destination, webhookTransport, webhookUrl } from '../lib/interview-service/delivery.ts';
import { seal, unseal } from '../lib/interview-service/security.ts';
import { handleCandidate, handleApi } from '../lib/interview-service/http.ts';

test('production webhook destinations reject HTTP, local, mapped, reserved, credentialed and unapproved addresses',async()=>{
  for (const address of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.0.1','169.254.169.254','100.100.100.200','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.1.1.1','255.255.255.255','0.0.0.0','::1','::ffff:127.0.0.1']) assert.equal(isPublicIPv4(address),false,address);
  assert.equal(isPublicIPv4('8.8.8.8'),true);
  for(const url of ['http://receiver.example','https://127.0.0.1','https://localhost','https://user:password@receiver.example','https://receiver.example:8443','https://receiver.example/#fragment','https://other.example']) await assert.rejects(destination(url,['receiver.example','localhost'],true));
  assert.throws(()=>webhookUrl('http://127.0.0.1:8080/webhook',true));
});
test('development webhook transport permits only explicitly allowlisted local IPv4 hosts',async()=>{
  let received;
  const server=createServer((request,response)=>{
    let body=''; request.setEncoding('utf8'); request.on('data',chunk=>body+=chunk);
    request.on('end',()=>{received={body,signature:request.headers['interview-signature']};response.writeHead(202).end();});
  });
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',error=>error?reject(error):resolve()));
  try {
    const address=server.address(); assert.equal(typeof address,'object');
    const url=`http://127.0.0.1:${address.port}/api/interview-service/webhook`;
    assert.equal((await destination(url,['127.0.0.1'],false)).address,'127.0.0.1');
    await assert.rejects(destination(url,['localhost'],false));
    await webhookTransport(['127.0.0.1'],false)(url,'{"event":"local"}',{'Interview-Signature':'v1=test'});
    assert.deepEqual(received,{body:'{"event":"local"}',signature:'v1=test'});
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
});
test('stored secrets are authenticated, randomized ciphertext',()=>{
  const key=randomBytes(32),secret='test credential'; const encrypted=seal(secret,key);
  assert.equal(unseal(encrypted,key),secret); assert.notEqual(encrypted,seal(secret,key));
  const tampered=Buffer.from(encrypted,'base64url'); tampered[tampered.length-1]^=1;
  assert.throws(()=>unseal(tampered.toString('base64url'),key));
  assert.throws(()=>unseal(encrypted,randomBytes(32)));
});
test('candidate mutation requires matching origin before accessing persistence',async()=>{
  const response=await handleCandidate(new Request('https://interviewer.test/candidate/start',{method:'POST'}),{origin:'https://interviewer.test'});
  assert.equal(response.status,403); assert.equal(response.headers.get('cache-control'),'no-store');
});
test('API bounds actual request bytes and never returns internal exception details',async()=>{
  const service={principal:async()=>({}),createWorkspace:async()=>assert.fail('Oversized body reached mutation')};
  const response=await handleApi(new Request('https://interviewer.test/v1/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({display_name:'x'.repeat(66000)})}),service);
  assert.equal(response.status,413);
  const failed=await handleApi(new Request('https://interviewer.test/v1/capabilities'),{principal:async()=>{throw new Error('postgresql://secret');}});
  assert.equal(failed.status,503); assert.doesNotMatch(await failed.text(),/postgresql|secret/);
});
