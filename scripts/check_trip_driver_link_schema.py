import pathlib, re, subprocess, tempfile, os, shutil
# Objective 1 KR2: every trip is linked to a signed-in driver account.
# Local PostgreSQL only. Creates synthetic Auth stubs in a temporary database.
# Never point this harness at an existing database. Override POSTGRES_BIN if needed.
BIN = pathlib.Path(os.environ.get('POSTGRES_BIN', '/Applications/Postgres.app/Contents/Versions/18/bin'))
BASE = pathlib.Path(tempfile.mkdtemp(prefix='hitch-kr2-check-'))
MIGRATIONS = pathlib.Path(__file__).resolve().parents[1] / 'supabase/migrations'
A = '11111111-1111-1111-1111-111111111111'
B = '22222222-2222-2222-2222-222222222222'
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
    insert into auth.users values ('{A}'),('{B}');
    """)
    for name in ('20261027000100_post_a_trip.sql', '20261104000100_request_a_seat.sql',
                 '20261106000100_trip_locations_search_ownership.sql', '20261108000200_kr_trips_linked_to_driver.sql'):
        sql((MIGRATIONS/name).read_text())
    def session(body, who, role='authenticated', rollback=True):
        return f"begin; set local role {role}; select set_config('request.jwt.claim.sub','{who}',true); {body}" + (' rollback;' if rollback else ' commit;')
    cols = "destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat"
    vals = "'moab', now()+interval '1 day', 'Helaman Halls', 'Moab', 3, 25"
    post = f"insert into public.trips ({cols}) values ({vals}) returning id, driver_id;"
    count = 0
    def check(body, who, error=0, role='authenticated'):
        global count
        r = sql(session(body, who, role), error); count += 1
        return r
    # Signed in: driver_id is filled in from the session.
    r = check(post, A)
    assert any(l.endswith(f'|{A}') for l in r.stdout.splitlines()), r.stdout
    # No anonymous trips: anon role, or authenticated role with no user in the token.
    check(post, '', '42501', role='anon')
    check(post, '', '42501')  # no user in the token -> auth.uid() is null -> the insert policy rejects it
    # Can't post as someone else, as nobody, or as an account that doesn't exist.
    check(f"insert into public.trips ({cols}, driver_id) values ({vals}, '{B}');", A, '42501')
    check(f"insert into public.trips ({cols}, driver_id) values ({vals}, null);", A, '42501')
    check(f"insert into public.trips ({cols}, driver_id) values ({vals}, '33333333-3333-3333-3333-333333333333');", A, '42501')
    # Even as postgres (dashboard/SQL Editor), a trip can't be unlinked.
    sql(f"insert into public.trips ({cols}, driver_id) values ({vals}, null);", '23502'); count += 1
    sql(f"insert into public.trips ({cols}, driver_id) values ({vals}, '33333333-3333-3333-3333-333333333333');", '23503'); count += 1
    # After posting, the trip can't be moved to another account or unlinked.
    trip = re.findall(r'^([0-9a-f-]{36})\|', sql(session(post, A, rollback=False)).stdout, re.M)[-1]
    check(f"update public.trips set driver_id = '{B}' where id = '{trip}';", A, '42501')
    check(f"update public.trips set driver_id = null where id = '{trip}';", A, '42501')
    sql(f"update public.trips set driver_id = null where id = '{trip}';", '23502'); count += 1
    # An account that has trips can't be deleted, so no trip loses its driver.
    sql(f"delete from auth.users where id = '{A}';", '23503'); count += 1
    # The KR views are private.
    for view in ('kr_trip_driver_link', 'kr_trip_driver_link_summary'):
        check(f'select * from public.{view};', A, '42501')
        check(f'select * from public.{view};', '', '42501', role='anon')
    # KR math as postgres: two trips, both linked -> 100.0.
    sql(session(post, B, rollback=False))
    r = sql('select trips, linked_trips, linked_rate from public.kr_trip_driver_link_summary;')
    assert '2|2|100.0' in r.stdout.splitlines(), r.stdout
    count += 1
    print(f'PASS: trip-driver link applied and {count} checks passed in isolated PostgreSQL 18 with auth stubs. Not a live Supabase or browser integration test.')
finally:
    if started: call([BIN/'pg_ctl','-D',BASE/'data','stop','-m','fast'])
    shutil.rmtree(BASE)
