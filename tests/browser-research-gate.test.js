'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),research=require('../src/browser-research');
test('public, account, private-domain and credential-bearing research requests fail closed with no evidence',()=>{
 for(const message of ['Research https://example.invalid for features Arecibo should adopt','Research my account','Visit http://127.0.0.1/admin','Research https://user:synthetic-value@example.invalid/?token=synthetic-token','Browse a website','Can you also visit https://example.invalid and list its capabilities','Open https://example.invalid and inspect its features','Log into https://example.invalid for analysis','Could you please research https://example.invalid?','I would like you to research https://example.invalid','Create a Mission to research https://example.invalid','/mission new Research https://example.invalid']){
  const result=research.parse(message);assert.equal(result.available,false);assert.equal(result.comparison,'unverified');assert.deepEqual(result.evidence,[]);assert.doesNotMatch(JSON.stringify(result),/synthetic-value|synthetic-token|\/admin/);assert.match(result.message,/unavailable/);
 }
 assert.equal(research.parse('Hi'),null);assert.equal(research.parse('Explain what browser research means'),null);
 assert.deepEqual(research.research({url:'https://example.invalid',authorized:true,credential:'synthetic-canary'}).evidence,[]);
});
