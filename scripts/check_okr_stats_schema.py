import pathlib, subprocess, tempfile, os, shutil
# All four Key Results on the admin stats page (okr_stats). Local PostgreSQL only, with Supabase-like stubs and
# every migration loaded. Never point this harness at an existing database. Override POSTGRES_BIN if needed.
BIN = pathlib.Path(os.environ.get('POSTGRES_BIN', '/Applications/Postgres.app/Contents/Versions/18/bin'))
BASE = pathlib.Path(tempfile.mkdtemp(prefix='hitch-okr-check-'))
MIGRATIONS = pathlib.Path(__file__).resolve().parents[1] / 'supabase/migrations'
ADMIN, D1, D2, D3, R1, R2, R3, OTHER = (f'{c*8}-{c*4}-4{c*3}-8{c*3}-{c*12}' for c in '12345678')
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
    # Supabase-like stubs: auth, storage, and "new tables/functions are granted to API roles by default".
    sql("""create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}');
    create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(), bucket_id text, name text, owner uuid); alter table storage.objects enable row level security;
    create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1,'/') $$;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;""")
    # D3 is a driver without a BYU email (a trip from before the verification rule).
    users = ','.join(f"('{u}', '{'u%d@gmail.com' % i if u == D3 else 'u%d@byu.edu' % i}', now())" for i, u in enumerate((ADMIN, D1, D2, D3, R1, R2, R3, OTHER)))
    sql(f"insert into auth.users (id, email, email_confirmed_at) values {users};")
    for m in sorted(MIGRATIONS.glob('*.sql')):
        sql(m.read_text())
    count = 0
    def check(body, who, error=0, role='authenticated'):
        global count
        count += 1
        return sql(f"begin; set local role {role}; select set_config('request.jwt.claim.sub','{who}',true); {body} rollback;", error)
    def okr():
        out = check("select kr, coalesce(current_value::text, ''), coalesce(numerator::text, ''), coalesce(denominator::text, ''), ready, target from public.okr_stats();", ADMIN).stdout
        return {line.split('|')[0]: line.split('|')[1:] for line in out.splitlines() if '|' in line}

    # ---------- Who can see it ----------
    sql(f"insert into public.admins (user_id) values ('{ADMIN}');")
    check('select * from public.okr_stats();', OTHER, '42501')
    check('select * from public.okr_stats();', '', '42501', role='anon')

    # ---------- Empty database: every KR ready, nothing eligible yet ----------
    k = okr()
    assert list(k) == ['drivers_verified', 'trips_linked', 'seat_fill', 'repeat_drivers'], k
    assert all(v[3] == 't' and v[0] == '' for v in k.values()), k
    assert [v[4] for v in k.values()] == ['1.0', '1.0', '0.70', '0.50'], k

    # ---------- Known data ----------
    # D1 (verified): trip 1 posted 40 days ago, trip 2 posted 35 days ago -> repeat driver.
    # D2 (verified): one trip posted 40 days ago -> eligible, not a repeat.
    # D3 (gmail, not verified): one trip posted today -> not yet eligible for the repeat KR.
    def trip(driver, seats, posted):
        return sql(f"insert into public.trips (driver_id, destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, created_at) values ('{driver}', 'moab', now() + interval '1 day', 'P', 'Moab', {seats}, 20, now() - interval '{posted} days') returning id;").stdout.split()[0]
    A, B, C, E = trip(D1, 4, 40), trip(D1, 2, 35), trip(D2, 3, 40), trip(D3, 2, 0)
    def req(t, rider, status):
        sql(f"insert into public.ride_requests (trip_id, rider_id, status) values ('{t}', '{rider}', '{status}');")
    for rider in (R1, R2, R3): req(A, rider, 'accepted')        # A: 3 of 4 -> 0.75
    req(C, R1, 'accepted'); req(C, R2, 'declined')              # C: 1 of 3 -> 0.3333
    sql(f"update public.trips set departure_at = now() - interval '1 day' where id in ('{A}', '{C}');")
    k = okr()
    assert k['drivers_verified'][:4] == ['0.6667', '2', '3', 't'], k   # 2 of 3 drivers verified
    assert k['trips_linked'][:4] == ['1.0000', '4', '4', 't'], k       # every trip has a driver account
    assert k['seat_fill'][:4] == ['0.5417', '4', '7', 't'], k          # average of 0.75 and 0.3333
    assert k['repeat_drivers'][:4] == ['0.5000', '1', '2', 't'], k     # D1 repeats, D2 doesn't
    count += 1

    # ---------- Live: an accept changes the seat fill on the next call ----------
    req(C, R3, 'pending')
    sql(f"update public.ride_requests set status = 'accepted' where trip_id = '{C}' and rider_id = '{R3}';")
    assert okr()['seat_fill'][:3] == ['0.7083', '5', '7'], okr()      # (0.75 + 0.6667) / 2
    count += 1

    # ---------- A KR whose view is missing doesn't break the others ----------
    sql("drop view public.kr_driver_repeat_rate_summary;")
    k = okr()
    assert k['repeat_drivers'][3] == 'f' and k['repeat_drivers'][0] == '', k
    assert k['drivers_verified'][3] == 't' and k['seat_fill'][3] == 't', k
    count += 1

    print(f'PASS: okr_stats applied and {count} checks passed in isolated PostgreSQL 18 with Supabase-like stubs. Not a live Supabase or browser integration test.')
finally:
    if started: call([BIN/'pg_ctl','-D',BASE/'data','stop','-m','fast'])
    shutil.rmtree(BASE)
