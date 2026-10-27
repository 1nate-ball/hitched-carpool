import pathlib, subprocess, tempfile, os, shutil
# Local PostgreSQL only. Creates synthetic Auth stubs in a temporary database.
# Never point this harness at an existing database. Override POSTGRES_BIN if needed.
BIN = pathlib.Path(os.environ.get('POSTGRES_BIN', '/Applications/Postgres.app/Contents/Versions/18/bin'))
BASE = pathlib.Path(tempfile.mkdtemp(prefix='hitch-schema-check-'))
SQL = pathlib.Path(__file__).resolve().parents[1] / 'supabase/migrations/20261027000100_post_a_trip.sql'
def call(cmd, **kw):
    return subprocess.run([str(x) for x in cmd], text=True, capture_output=True, **kw)
r = call([BIN/'initdb','-D',BASE/'data','-A','trust','--no-locale'])
assert r.returncode == 0, r.stderr
started = False
try:
    r = call([BIN/'pg_ctl','-D',BASE/'data','-l',BASE/'server.log','-o',f"-k {BASE} -h ''",'start'])
    assert r.returncode == 0, r.stderr + r.stdout
    started = True
    def sql(body, code=0):
        r = call([BIN/'psql','-h',BASE,'-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-At'], input=body)
        assert (r.returncode == 0) if code == 0 else (r.returncode != 0 and code in r.stderr), r.stdout+r.stderr
        return r
    sql("""create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    insert into auth.users values ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222');
    """)
    sql(SQL.read_text())
    owner = '11111111-1111-1111-1111-111111111111'
    vals = dict(destination_id="'moab'", departure_at="now()+interval '1 day'",pickup_location="'Helaman Halls'", dropoff_location="'Moab'",total_seats='3',price_per_seat='25',return_at='null')
    def insert(changes=None):
        v = {**vals, **(changes or {})}
        return 'insert into public.trips ('+', '.join(v)+') values ('+', '.join(v.values())+') returning id;'
    def session(body, role='authenticated', uid=owner, rollback=True):
        return f"begin; set local role {role}; select set_config('request.jwt.claim.sub','{uid}',true); {body}"+('rollback;' if rollback else 'commit;')
    count = 0
    def check(body, error=0, role='authenticated', uid=owner):
        global count
        sql(session(body,role,uid),error); count += 1
    check(insert())
    check(insert({'return_at':"now()+interval '2 days'"}))
    for seats in ('1','7'): check(insert({'total_seats':seats}))
    for price in ('1','150'): check(insert({'price_per_seat':price}))
    for changes in ({'total_seats':'0'},{'total_seats':'8'},{'price_per_seat':'0'},{'price_per_seat':'151'},{'pickup_location':"'   '"},{'dropoff_location':"''"},{'departure_at':"now()-interval '1 day'"},{'return_at':"now()+interval '1 day'"},{'return_at':"now()"}):
        check(insert(changes),'23514')
    check(insert({'destination_id':"'unknown'"}),'23503')
    check(insert({'departure_at':'null'}),'23502')
    check(insert({'total_seats':"'1.5'"}),'22P02')
    check(insert({'price_per_seat':"'1.5'"}),'22P02')
    check(insert({'driver_id':"'22222222-2222-2222-2222-222222222222'"}),'42501')
    check(insert(),'42501',role='anon',uid='')
    check('select * from public.trips;','42501',role='anon',uid='')
    check('update public.trips set total_seats=2;','42501')
    check('delete from public.trips;','42501')
    check(insert({'created_at':'now()'}),'42501')
    check("insert into public.destinations values ('x','x');",'42501')
    check(insert(),'42501',uid='')
    sql(session(insert(),rollback=False))
    r=sql(session("select driver_id, return_at is null as one_way, departure_at > now() as future from public.trips;",uid='22222222-2222-2222-2222-222222222222'))
    assert f'{owner}|t|t' in r.stdout.splitlines(), r.stdout
    count += 1
    print(f'PASS: schema applied and {count} constraint/access checks passed in isolated PostgreSQL 18 with auth stubs. Not a live Supabase or browser integration test.')
finally:
    if started: call([BIN/'pg_ctl','-D',BASE/'data','stop','-m','fast'])
    shutil.rmtree(BASE)
