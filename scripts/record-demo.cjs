// Run from the repository root with Playwright installed. Uses a temporary DB.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const base = 'http://127.0.0.1:8123';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hitch-demo-'));
let server, browser;
const logs = [];
async function start() {
  server = spawn('python3', ['server.py'], {env:{...process.env,PORT:'8123',HITCH_DB:path.join(temp,'demo.sqlite3')}});
  server.stdout.on('data',d=>logs.push(String(d)));
  server.stderr.on('data',d=>logs.push(String(d)));
  for (let i=0;i<100;i++) {
    try { if ((await fetch(base+'/api/profile')).ok) return; } catch {}
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('Server did not start');
}
async function stop(){
  if (server && server.exitCode===null) {
    const finished = new Promise(resolve=>server.once('exit',resolve));
    server.kill(); await finished;
  }
}
(async()=>{
  try {
    await start();
    browser=await chromium.launch({headless:true});
    const context=await browser.newContext({viewport:{width:1280,height:1000},colorScheme:'light',recordVideo:{dir:'demo-recording',size:{width:1280,height:1000}}});
    const page=await context.newPage();
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const requests=[];
    page.on('response',r=>{if(r.url().includes('/api/profile'))requests.push({method:r.request().method(),status:r.status()});});
    await page.goto(base);
    await page.getByRole('heading',{name:'Jordan Hale'}).waitFor();
    // Keep each milestone visible long enough to follow in the submission video.
    await page.waitForTimeout(6000);
    await page.getByRole('button',{name:'Edit profile',exact:true}).click();
    await page.waitForTimeout(3000);
    await page.getByLabel('Hometown',{exact:true}).fill('');
    await page.getByLabel('Hometown',{exact:true}).pressSequentially('Boise, ID',{delay:130});
    await page.getByLabel('Short bio',{exact:true}).fill('');
    await page.getByLabel('Short bio',{exact:true}).pressSequentially('Ready for our next road trip!',{delay:100});
    await page.getByRole('button',{name:'Avatar color #3B6EA8',exact:true}).click();
    await page.waitForTimeout(4000);
    const saved=page.waitForResponse(r=>r.url().endsWith('/api/profile')&&r.request().method()==='PATCH');
    await page.getByRole('button',{name:'Save changes',exact:true}).click();
    const response=await saved;
    assert.equal(response.status(),200);
    const payload=await response.json();
    assert.equal(payload.hometown,'Boise, ID');
    assert.equal(payload.bio,'Ready for our next road trip!');
    await page.getByText('Ready for our next road trip!',{exact:true}).waitFor();
    await page.waitForTimeout(8000);
    // Real full-document navigation; no localStorage is used for profile data.
    await page.reload({waitUntil:'load'});
    await page.getByText('Boise, ID',{exact:true}).waitFor();
    await page.getByText('Ready for our next road trip!',{exact:true}).waitFor();
    await page.waitForTimeout(10000);
    assert.deepEqual(errors,[]);
    const video=page.video();
    await context.close();
    await video.saveAs('demo-recording/source.webm');
    // Check durability beyond the required browser refresh.
    await stop(); await start();
    const restartProfile=await (await fetch(base+'/api/profile')).json();
    assert.equal(restartProfile.bio,'Ready for our next road trip!');
    const counts=JSON.parse(require('node:child_process').execFileSync('python3',['-c',
      "import sqlite3,json,sys; d=sqlite3.connect(sys.argv[1]); print(json.dumps({t:d.execute('SELECT COUNT(*) FROM '+t).fetchone()[0] for t in ['Users','Destinations','Trips','RideRequests','Messages']}))",path.join(temp,'demo.sqlite3')],{encoding:'utf8'}));
    for(const count of Object.values(counts))assert.ok(count>=2);
    fs.writeFileSync('docs/verification.json',JSON.stringify({verifiedAt:new Date().toISOString(),browser:'Chromium',saveRequestStatus:response.status(),updatedValuesDisplayed:true,browserRefreshPreservedValues:true,serverRestartPreservedValues:true,consoleErrors:errors,requests,sampleRows:counts},null,2)+'\n');
    console.log('PASS: browser click, database update, returned UI, refresh, and server restart.');
  } finally {
    if(browser)await browser.close();
    await stop(); fs.rmSync(temp,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);console.error(logs.join(''));process.exitCode=1;});
