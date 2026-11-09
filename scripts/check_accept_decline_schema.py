import pathlib, re, subprocess, tempfile, os, shutil, threading, time
# Driver accepts/declines seat requests. Local PostgreSQL only, with synthetic Auth stubs.
# Never point this harness at an existing database. Override POSTGRES_BIN if needed.
BIN = pathlib.Path(os.environ.get('POSTGRES_BIN', '/Applications/Postgres.app/Contents/Versions/18/bin'))
BASE = pathlib.Path(tempfile.mkdtemp(prefix='hitch-decide-check-'))
MIGRATIONS = pathlib.Path(__file__).resolve().parents[1] / 'supabase/migrations'
DRIVER, R1, R2, R3, OTHER = (f'{c*8}-{c*4}-4{c*3}-8{c*3}-{c*12}' for c in '12345')
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
    users = ','.join(f"('{u}')" for u in (DRIVER, R1, R2, R3, OTHER))
    sql(f"""create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    insert into auth.users values {users};
    """)
    for name in ('20261027000100_post_a_trip.sql', '20261104000100_request_a_seat.sql',
                 '20261106000100_trip_locations_search_ownership.sql', '20261109000100_accept_decline_requests.sql'):
        sql((MIGRATIONS/name).read_text())
    def session(body, who, role='authenticated', rollback=True):
        return f"begin; set local role {role}; select set_config('request.jwt.claim.sub','{who}',true); {body}" + (' rollback;' if rollback else ' commit;')
    def last_uuid(out): return re.findall(r'^([0-9a-f-]{36})$', out, re.M)[-1]
    # A 2-seat trip with three pending requests, all committed.
    trip = last_uuid(sql(session("insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat) values ('moab', now()+interval '1 day', 'Helaman Halls', 'Moab', 2, 25) returning id;", DRIVER, rollback=False)).stdout)
    for rider in (R1, R2, R3):
        sql(session(f"insert into public.ride_requests (trip_id, note) values ('{trip}', 'hi');", rider, rollback=False))
    req = lambda rider: f"(select id from public.ride_requests where trip_id = '{trip}' and rider_id = '{rider}')"
    status = lambda rider: sql(f"select status from public.ride_requests where trip_id = '{trip}' and rider_id = '{rider}';").stdout.strip()
    seats_available = lambda: sql(session(f"select coalesce((select seats_available from public.available_trips where id = '{trip}'), -1);", OTHER)).stdout.splitlines()[-2]
    set_status = lambda rider, value: f"update public.ride_requests set status = '{value}' where id = {req(rider)} returning status;"
    count = 0
    def check(body, who, error=0, role='authenticated', rollback=True):
        global count
        r = sql(session(body, who, role, rollback), error); count += 1
        return r
    # The driver sees all three pending requests on their trip.
    r = check(f"select count(*) from public.ride_requests where trip_id = '{trip}' and status = 'pending';", DRIVER)
    assert r.stdout.splitlines()[-2] == '3', r.stdout
    assert seats_available() == '2'
    # Riders and strangers can't decide: their update matches no rows. Anonymous callers are refused.
    for who in (R1, OTHER):
        r = check(set_status(R1, 'accepted'), who)
        assert 'accepted' not in r.stdout.splitlines(), (who, r.stdout)
    check(set_status(R1, 'accepted'), '', '42501', role='anon')
    assert status(R1) == 'pending'
    # The driver can change only the status column.
    check(f"update public.ride_requests set note = 'edited' where id = {req(R1)};", DRIVER, '42501')
    check(f"update public.ride_requests set rider_id = '{OTHER}' where id = {req(R1)};", DRIVER, '42501')
    check(set_status(R1, 'maybe'), DRIVER, '23514')
    # Accept R1: seats left goes 2 -> 1.
    check(set_status(R1, 'accepted'), DRIVER, rollback=False)
    assert status(R1) == 'accepted' and seats_available() == '1', (status(R1), seats_available())
    # A decision is final.
    check(set_status(R1, 'declined'), DRIVER, '23514')
    check(set_status(R1, 'pending'), DRIVER, '23514')
    # Decline R3: seats unchanged.
    check(set_status(R3, 'declined'), DRIVER, rollback=False)
    assert status(R3) == 'declined' and seats_available() == '1'
    check(set_status(R3, 'accepted'), DRIVER, '23514')
    # Accept R2 fills the trip, so it drops out of search.
    check(set_status(R2, 'accepted'), DRIVER, rollback=False)
    assert seats_available() == '-1', seats_available()
    # Over capacity is refused, even for postgres.
    sql(f"insert into public.ride_requests (trip_id, rider_id, note, status) values ('{trip}', '{OTHER}', '', 'pending');")
    sql(set_status(OTHER, 'accepted'), '23514'); count += 1
    # Two accepts racing for the last seat of a new 1-seat trip: exactly one wins.
    trip2 = last_uuid(sql(session("insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat) values ('zion', now()+interval '1 day', 'Wyview', 'Zion', 1, 30) returning id;", DRIVER, rollback=False)).stdout)
    for rider in (R1, R2):
        sql(session(f"insert into public.ride_requests (trip_id, note) values ('{trip2}', '');", rider, rollback=False))
    results = {}
    def accept(rider, delay):
        time.sleep(delay)
        body = session(f"update public.ride_requests set status = 'accepted' where trip_id = '{trip2}' and rider_id = '{rider}'; select pg_sleep(1);", DRIVER, rollback=False)
        results[rider] = call([BIN/'psql','-h',BASE,'-d','postgres','-v','ON_ERROR_STOP=1','-At'], input=body).returncode
    threads = [threading.Thread(target=accept, args=(R1, 0)), threading.Thread(target=accept, args=(R2, 0.2))]
    for t in threads: t.start()
    for t in threads: t.join()
    accepted = sql(f"select count(*) from public.ride_requests where trip_id = '{trip2}' and status = 'accepted';").stdout.strip()
    assert accepted == '1' and sorted(results.values()) == [0, 3], (accepted, results)
    count += 1
    # Seat-fill KR views are private, and the math matches the SQLite definition.
    for view in ('kr_seat_fill_rate', 'kr_seat_fill_rate_summary'):
        check(f'select * from public.{view};', DRIVER, '42501')
    sql(f"alter table public.trips disable trigger validate_new_trip_departure; update public.trips set departure_at = now() - interval '1 day';")
    r = sql(f"select accepted_seats, fill_rate from public.kr_seat_fill_rate where trip_id = '{trip}'; select departed_trips, avg_fill_rate from public.kr_seat_fill_rate_summary;")
    lines = r.stdout.splitlines()
    # trip: 2 of 2 seats accepted -> 1.0. trip2: 1 of 1 -> 1.0. Average over 2 departed trips -> 1.0.
    seats, rate = lines[0].split('|'); trips_n, avg = lines[1].split('|')
    assert (seats, float(rate), trips_n, float(avg)) == ('2', 1.0, '2', 1.0), lines
    count += 1
    print(f'PASS: accept/decline applied and {count} checks passed in isolated PostgreSQL 18 with auth stubs. Not a live Supabase or browser integration test.')
finally:
    if started: call([BIN/'pg_ctl','-D',BASE/'data','stop','-m','fast'])
    shutil.rmtree(BASE)
