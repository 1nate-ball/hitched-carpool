const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const uid = '11111111-1111-4111-8111-111111111111';
const oldPath = `${uid}/22222222-2222-4222-8222-222222222222.jpg`;

async function fixture(mode='ok') {
  const calls=[]; let current=oldPath;
  global.fetch=async(url,options={})=>{
    const reply=(status,data)=>({ok:status<300,status,json:async()=>data});
    if(url==='/supabase-config.json') return reply(200,{url:'https://photos.test',publishableKey:'public-test'});
    const body=options.body instanceof Blob ? options.body : options.body ? JSON.parse(options.body) : null;
    calls.push({url,method:options.method,body});
    if(url.includes('/storage/v1/object/sign/')) return reply(200,{signedURL:'/object/sign/profile-photos/'+url.split('/profile-photos/')[1]+'?token=test'});
    if(url.includes('/storage/v1/')) return reply(200,{});
    if(options.method==='PATCH') {
      if(mode==='reject') return reply(403,{message:'Not your profile'});
      current=body.avatar_path;
      if(mode==='lost') throw new TypeError('Lost response');
    }
    return reply(200,[{id:uid,full_name:'Test User',avatar_path:current}]);
  };
  const api=await import(pathToFileURL(path.resolve('public/hitch-supabase.js')).href+'?photo='+Math.random());
  return {api,calls};
}
test('a new photo is uploaded and linked before the previous file is removed',async()=>{
  const {api,calls}=await fixture();
  const result=await api.saveProfilePhoto('test-session',uid,new Blob(['test JPEG'],{type:'image/jpeg'}));
  assert.match(result.avatar_path,new RegExp(`^${uid}/[a-f0-9-]+\\.jpg$`));
  assert.match(result.photo,/https:\/\/photos.test\/storage\/v1\/object\/sign\//);
  const saved=calls.findIndex(c=>c.method==='PATCH'), removed=calls.findIndex(c=>c.method==='DELETE');
  assert.ok(saved>0 && removed>saved);
  assert.deepEqual(calls[removed].body,{prefixes:[oldPath]});
});
test('rejected profile writes clean up only the new upload, keeping the original photo',async()=>{
  const {api,calls}=await fixture('reject');
  await assert.rejects(api.saveProfilePhoto('test-session',uid,new Blob(['x'],{type:'image/jpeg'})),/Not your profile/);
  const deleted=calls.filter(c=>c.method==='DELETE');
  assert.equal(deleted.length,1); assert.notEqual(deleted[0].body.prefixes[0],oldPath);
});
test('a lost save response is reconciled without deleting the newly attached photo',async()=>{
  const {api,calls}=await fixture('lost');
  const result=await api.saveProfilePhoto('test-session',uid,new Blob(['x'],{type:'image/jpeg'}));
  assert.ok(result.avatar_path); assert.equal(calls.some(c=>c.method==='DELETE'),false);
});
test('removing a photo clears the profile before removing its file',async()=>{
  const {api,calls}=await fixture();
  assert.deepEqual(await api.saveProfilePhoto('test-session',uid,null),{avatar_path:null,photo:null});
  assert.ok(calls.findIndex(c=>c.method==='PATCH')<calls.findIndex(c=>c.method==='DELETE'));
});
test('invalid photo types, large uploads and arbitrary photo paths never reach storage',async()=>{
  const {api,calls}=await fixture();
  await assert.rejects(api.saveProfilePhoto('test-session',uid,new Blob(['<svg/>'],{type:'image/svg+xml'})),/valid profile photo/);
  await assert.rejects(api.saveProfilePhoto('test-session',uid,new Blob([new Uint8Array(1048577)],{type:'image/jpeg'})),/1 MB/);
  assert.equal(await api.profilePhotoUrl('test-session','https://untrusted.test/photo.jpg'),null);
  assert.equal(calls.length,0);
});
