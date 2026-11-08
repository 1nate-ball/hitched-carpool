// Run with: node --test tests/test_auth.cjs
// Sign Up / Log In / Log Out against a fake Supabase Auth API (no live accounts are created).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

// ---- hitch-supabase.js with a fake fetch + localStorage ----
async function helper(handler) {
  const store = new Map();
  global.localStorage = {getItem:k => store.has(k) ? store.get(k) : null, setItem:(k,v) => store.set(k, String(v)), removeItem:k => store.delete(k)};
  const calls = [];
  global.fetch = async (url, init = {}) => {
    if (url === '/supabase-config.json') return {ok:true, json:async () => ({url:'https://db.test', publishableKey:'pk'})};
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({url, body});
    const [status, data] = handler(url, body);
    return {ok:status < 300, status, json:async () => data};
  };
  // Fresh module instance per test (the module caches its config).
  const file = pathToFileURL(path.resolve('public/hitch-supabase.js')).href + '?t=' + Math.random();
  return {api:await import(file), calls, store};
}
const authOk = {access_token:'at', refresh_token:'rt', expires_in:3600, user:{id:'u1', email:'jo@byu.edu', identities:[{}]}};

test('sign up sends name as metadata and signs in when Supabase returns a session', async () => {
  const {api, calls, store} = await helper(() => [200, authOk]);
  const res = await api.signUp(' Jo Smith ', 'Jo@BYU.edu', 'abc12345');
  assert.equal(res.session.user.id, 'u1');
  assert.match(calls[0].url, /\/auth\/v1\/signup/);
  assert.deepEqual(calls[0].body, {email:'jo@byu.edu', password:'abc12345', data:{full_name:'Jo Smith'}});
  assert.ok(store.get('hitch-supabase-session'), 'session saved so a refresh stays signed in');
});

test('sign up with email confirmation on asks the user to confirm', async () => {
  const {api, store} = await helper(() => [200, {id:'u1', email:'jo@byu.edu', identities:[{}]}]);
  assert.deepEqual(await api.signUp('Jo', 'jo@byu.edu', 'abc12345'), {needsConfirmation:true});
  assert.equal(store.size, 0);
});

test('duplicate email is reported both when Supabase errors and when it hides the duplicate', async () => {
  const a = await helper(() => [422, {code:422, error_code:'user_already_exists', msg:'User already registered'}]);
  await assert.rejects(a.api.signUp('Jo', 'jo@byu.edu', 'abc12345'), e => e.code === 'user_already_exists');
  const b = await helper(() => [200, {id:'u1', email:'jo@byu.edu', identities:[]}]);
  await assert.rejects(b.api.signUp('Jo', 'jo@byu.edu', 'abc12345'), e => e.code === 'user_already_exists');
});

test('weak password from Supabase keeps its code and message', async () => {
  const {api} = await helper(() => [422, {error_code:'weak_password', msg:'Password should be at least 6 characters.'}]);
  await assert.rejects(api.signUp('Jo', 'jo@byu.edu', 'abc'), e => e.code === 'weak_password' && /6 characters/.test(e.message));
});

test('log in saves the session, log out clears it and revokes the token', async () => {
  const {api, calls, store} = await helper(() => [200, authOk]);
  await api.signIn('jo@byu.edu', 'abc12345');
  assert.equal((await api.getSession()).accessToken, 'at');
  api.signOut();
  assert.equal(await api.getSession(), null);
  assert.equal(store.size, 0);
  assert.match(calls.at(-1).url, /\/auth\/v1\/logout/);
});

test('expired token refreshes; a rejected refresh signs out; a network drop keeps the session', async () => {
  let mode = 'ok';
  const {api, store} = await helper(url => {
    if (url.includes('grant_type=password')) return [200, {...authOk, expires_in:1}];
    if (mode === 'ok') return [200, {...authOk, access_token:'at2'}];
    if (mode === 'rejected') return [400, {error_code:'refresh_token_not_found'}];
    throw new TypeError('network');
  });
  await api.signIn('jo@byu.edu', 'abc12345');
  assert.equal((await api.getSession()).accessToken, 'at2');
  const expire = () => { const s = JSON.parse(store.get('hitch-supabase-session')); s.expiresAt = 0; store.set('hitch-supabase-session', JSON.stringify(s)); };
  expire(); mode = 'down';
  assert.equal(await api.getSession(), null);
  assert.ok(store.get('hitch-supabase-session'), 'kept for when the connection returns');
  mode = 'rejected';
  assert.equal(await api.getSession(), null);
  assert.equal(store.size, 0);
});

// ---- index.html: route guard and sign-up form rules ----
function stubElement() { // just enough of a DOM element for render() and the screen binders
  return {dataset:{}, innerHTML:'', value:'', hidden:true, focus(){}, addEventListener(){}, setAttribute(){},
    closest(){ return {classList:{toggle(){}}}; }, querySelectorAll(){ return []; }};
}
function app() {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\nboot\(\);/, '');
  const context = vm.createContext({console:{...console, warn(){}}, Date, Intl, setTimeout, clearTimeout, sessionStorage:{getItem(){ return null; }, setItem(){}, removeItem(){}},
    document:{getElementById:() => stubElement(), addEventListener(){}, querySelectorAll(){ return []; }}, window:{scrollTo(){}}});
  vm.runInContext(source, context);
  return code => vm.runInContext(code, context);
}

test('signed out, protected pages redirect to Log in and remember where you were going', () => {
  const run = app();
  run("S.me = {first:'Jo', last:'Smith', color:'#3B6EA8', verified:'verified', hometown:'', bio:''};");
  for (const screen of ['mytrips', 'post', 'profile', 'edit']) {
    run(`S.after = null; go('${screen}', {}, false);`);
    assert.equal(run('S.screen'), 'login', screen);
    assert.equal(run('S.after.screen'), screen);
  }
  run("go('home', {}, false);");
  assert.equal(run('S.screen'), 'home', 'Explore stays public');
  run("DB.session = {accessToken:'t', user:{id:'u1', email:'jo@byu.edu'}}; go('profile', {}, false);");
  assert.equal(run('S.screen'), 'profile');
});

test('log out returns to the login screen and forgets the session', async () => {
  const run = app();
  run("S.me = {first:'Jo', last:'Smith', color:'#3B6EA8', verified:'verified', hometown:'', bio:''}; DB.api = {signOut(){ this.out = true; }}; DB.session = {accessToken:'t', user:{id:'u1', email:'jo@byu.edu'}}; go('profile', {}, false);");
  await run("logOut('bye')");
  assert.equal(run('S.screen'), 'login');
  assert.equal(run('DB.session'), null);
  assert.equal(run('DB.api.out'), true);
});

test('sign-up rules: BYU email and a password with a letter and number', () => {
  const run = app();
  assert.equal(run("SCHOOL_EMAIL.test('jo@byu.edu')"), true);
  assert.equal(run("SCHOOL_EMAIL.test('jo@student.byu.edu')"), true);
  assert.equal(run("SCHOOL_EMAIL.test('jo@gmail.com')"), false);
  assert.notEqual(run("passwordProblem('short1')"), '');
  assert.notEqual(run("passwordProblem('longpassword')"), '');
  assert.equal(run("passwordProblem('longpass1')"), '');
});

test('profile name from the account replaces the sample name', () => {
  const run = app();
  run("S.me = {first:'Jordan', last:'Hale'}; DB.profile = {full_name:'Robbie  McVey'}; applyAccountName();");
  assert.equal(run('fullName(S.me)'), 'Robbie McVey');
});
