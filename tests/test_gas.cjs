const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const load=()=>import('data:text/javascript;base64,'+Buffer.from(fs.readFileSync('public/hitch-gas.js')).toString('base64'));
test('gas is split equally across driver and riders, and a return doubles it',async()=>{
 const {gasShare}=await load();
 const input={miles:240,mpg:30,price:4,seats:3,roundTrip:false};
 assert.deepEqual(gasShare(input),{total:32,perPerson:8,suggested:8});
 assert.deepEqual(gasShare({...input,roundTrip:true}),{total:64,perPerson:16,suggested:16});
 assert.equal(gasShare({...input,price:4.1}).suggested,9);
});
test('missing, non-finite, and invalid assumptions never produce a price',async()=>{
 const {gasShare}=await load(), input={miles:240,mpg:30,price:4,seats:3};
 for(const change of [{mpg:0},{miles:0},{price:NaN},{seats:0},{seats:1.5},{mpg:Infinity},{miles:10001},{price:30}]) assert.equal(gasShare({...input,...change}),null);
});
