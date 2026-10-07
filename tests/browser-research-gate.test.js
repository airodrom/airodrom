'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),research=require('../src/browser-research');
test('operator public research identifies exactly one domain; explicit Missions preserve research intent',()=>{
 for(const message of ['Research https://example.invalid for features Arecibo should adopt','Can you also visit https://example.invalid and list its capabilities','Open https://example.invalid and inspect its features','I would like you to research https://example.invalid','Create a Mission to research https://example.invalid','/mission new Research https://example.invalid','Airo, research https://example.invalid, explore its product, compare it with Arecibo and tell me what we should build.']){
  const result=research.parse(message);assert.equal(result.kind,'research');assert.equal(result.entry_url,'https://example.invalid/');assert.deepEqual(result.capability_classes,['web_read']);
 }
 assert.equal(research.parse('Hi'),null);assert.equal(research.parse('Explain what browser research means'),null);
});
test('private/ambiguous and combined account or implementation intent cannot grant a browser capability',()=>{
 for(const message of ['Research my account','Visit http://127.0.0.1/admin','Research https://user:synthetic-value@example.invalid/?token=synthetic-token','Browse a website','Log into https://example.invalid for analysis','Research https://example.invalid and deploy recommendations','Research https://example.invalid and https://second.invalid']){
  const result=research.parse(message);assert.equal(result.kind,'clarify');assert.equal(result.entry_url,undefined);assert.doesNotMatch(JSON.stringify(result),/synthetic-value|synthetic-token|\/admin/);
 }
 assert.deepEqual(research.research({url:'https://example.invalid',authorized:true,credential:'synthetic-canary'}).evidence,[]);
});
