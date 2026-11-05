import pathlib, re, subprocess, tempfile, os, shutil
# Local PostgreSQL only. Creates synthetic Auth stubs in a temporary database.
# Never point this harness at an existing database. Override POSTGRES_BIN if needed.
BIN = pathlib.Path(os.environ.get('POSTGRES_BIN', '/Applications/Postgres.app/Contents/Versions/18/bin'))
BASE = pathlib.Path(tempfile.mkdtemp(prefix='hitch-request-check-'))
MIGRATIONS = pathlib.Path(__file__).resolve().parents[1] / 'supabase/migrations'
DRIVER = '11111111-1111-1111-1111-111111111111'
RIDER = '22222222-2222-2222-2222-222222222222'
OTHER = '33333333-3333-3333-3333-333333333333'
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
    sql(f"""create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    insert into auth.users values ('{DRIVER}'),('{RIDER}'),('{OTHER}');
    """)
    sql((MIGRATIONS/'20261027000100_post_a_trip.sql').read_text())
    sql((MIGRATIONS/'20261104000100_request_a_seat.sql').read_text())
    def session(body, uid, role='authenticated', rollback=True):
        return f"begin; set local role {role}; select set_config('request.jwt.claim.sub','{uid}',true); {body}"+(' rollback;' if rollback else ' commit;')
    # One committed trip, driven by DRIVER, that every check below runs against.
    trip = sql(session("insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat) values ('moab', now()+interval '1 day', 'Helaman Halls', 'Moab', 3, 25) returning id;", DRIVER, rollback=False)).stdout
    trip = re.findall(r'^[0-9a-f-]{36}$', trip, re.M)[-1]  # last line is the returned id; set_config echoes the user id first
    def ask(note="'Can bring snacks'", extra=''):
        cols, vals = 'trip_id, note', f"'{trip}', {note}"
        if extra: k, v = extra.split('=', 1); cols += f', {k}'; vals += f', {v}'
        return f'insert into public.ride_requests ({cols}) values ({vals}) returning rider_id, status, note;'
    count = 0
    def check(body, uid, error=0, role='authenticated'):
        global count
        r = sql(session(body, uid, role), error); count += 1
        return r
    # Happy path: rider id comes from the session and status starts pending.
    r = check(ask(), RIDER)
    assert f'{RIDER}|pending|Can bring snacks' in r.stdout.splitlines(), r.stdout
    check(ask("''"), RIDER)
    check(ask("repeat('a', 300)"), RIDER)
    # Can't request your own trip.
    check(ask(), DRIVER, '42501')
    # Can't request the same trip twice.
    check(ask() + ask(), RIDER, '23505')
    # Client can't choose status, rider, id, or timestamp.
    check(ask(extra="status='accepted'"), RIDER, '42501')
    check(ask(extra=f"rider_id='{OTHER}'"), RIDER, '42501')
    check(ask(extra="created_at=now()"), RIDER, '42501')
    check(ask(extra="id=gen_random_uuid()"), RIDER, '42501')
    # Note length and bad trips.
    check(ask("repeat('a', 301)"), RIDER, '23514')
    check(ask("null"), RIDER, '23502')
    check(f"insert into public.ride_requests (trip_id) values ('{OTHER}');", RIDER, '23503')
    # Signed-out and anonymous callers.
    check(ask(), '', '42501')
    check(ask(), '', '42501', role='anon')
    check('select * from public.ride_requests;', '', '42501', role='anon')
    # No update/delete yet.
    check(ask() + "update public.ride_requests set status='accepted';", RIDER, '42501')
    check(ask() + 'delete from public.ride_requests;', RIDER, '42501')
    # Visibility: rider and driver see the request, an unrelated user doesn't.
    sql(session(ask(), RIDER, rollback=False))
    seen = lambda uid: sql(session('select count(*) from public.ride_requests;', uid)).stdout.splitlines()[-2]
    assert seen(RIDER) == '1' and seen(DRIVER) == '1' and seen(OTHER) == '0', (seen(RIDER), seen(DRIVER), seen(OTHER))
    count += 1
    # Deleting the trip removes its requests.
    sql(f"delete from public.trips where id='{trip}';")
    assert sql('select count(*) from public.ride_requests;').stdout.split()[-1] == '0'
    count += 1
    print(f'PASS: ride_requests applied and {count} constraint/access checks passed in isolated PostgreSQL 18 with auth stubs. Not a live Supabase or browser integration test.')
finally:
    if started: call([BIN/'pg_ctl','-D',BASE/'data','stop','-m','fast'])
    shutil.rmtree(BASE)
