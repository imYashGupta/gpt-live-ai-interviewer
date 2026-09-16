import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { isPublicIPv4, destination } from '../lib/interview-service/delivery.ts';
import { seal, unseal } from '../lib/interview-service/security.ts';
import { handleCandidate, handleApi } from '../lib/interview-service/http.ts';

test('webhook destinations reject local, mapped, reserved, credentialed and unapproved addresses',async()=>{
  for (const address of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.0.1','169.254.169.254','100.100.100.200','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.1.1.1','255.255.255.255','0.0.0.0','::1','::ffff:127.0.0.1']) assert.equal(isPublicIPv4(address),false,address);
  assert.equal(isPublicIPv4('8.8.8.8'),true);
  for(const url of ['http://receiver.example','https://127.0.0.1','https://user:password@receiver.example','https://receiver.example:8443','https://receiver.example/#fragment','https://other.example']) await assert.rejects(destination(url,['receiver.example']));
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
