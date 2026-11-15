import pathlib, re, subprocess, tempfile, os, shutil
# Cancel a seat request or a posted trip. Local PostgreSQL only, with synthetic Auth stubs.
# Never point this harness at an existing database. Override POSTGRES_BIN if needed.
BIN = pathlib.Path(os.environ.get('POSTGRES_BIN', '/Applications/Postgres.app/Contents/Versions/18/bin'))
BASE = pathlib.Path(tempfile.mkdtemp(prefix='hitch-cancel-check-'))
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
                 '20261106000100_trip_locations_search_ownership.sql', '20261109000100_accept_decline_requests.sql',
                 '20261115000100_cancel_request_or_trip.sql'):
        sql((MIGRATIONS/name).read_text())
    def session(body, who, role='authenticated', rollback=True):
        return f"begin; set local role {role}; select set_config('request.jwt.claim.sub','{who}',true); {body}" + (' rollback;' if rollback else ' commit;')
    def last_uuid(out): return re.findall(r'^([0-9a-f-]{36})$', out, re.M)[-1]
    count = 0
    def check(body, who, error=0, role='authenticated', rollback=True):
        global count
        r = sql(session(body, who, role, rollback), error); count += 1
        return r
    def new_trip(seats=2):
        return last_uuid(sql(session(f"insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat) values ('moab', now()+interval '1 day', 'Helaman Halls', 'Moab', {seats}, 25) returning id;", DRIVER, rollback=False)).stdout)
    trip = new_trip()
    for rider in (R1, R2, R3):
        sql(session(f"insert into public.ride_requests (trip_id, note) values ('{trip}', 'hi');", rider, rollback=False))
    active = lambda rider, t=trip: f"(select id from public.ride_requests where trip_id = '{t}' and rider_id = '{rider}' and status <> 'cancelled')"
    statuses = lambda rider, t=trip: sql(f"select string_agg(status, ',' order by created_at, status) from public.ride_requests where trip_id = '{t}' and rider_id = '{rider}';").stdout.strip()
    seats_available = lambda t=trip: sql(session(f"select coalesce((select seats_available from public.available_trips where id = '{t}'), -1);", OTHER)).stdout.splitlines()[-2]
    set_status = lambda rider, value, t=trip: f"update public.ride_requests set status = '{value}' where id = {active(rider, t)} returning status;"

    # ---------- Rider cancels a request ----------
    # A rider can't accept or decline their own request.
    check(set_status(R1, 'accepted'), R1, '42501')
    check(set_status(R1, 'declined'), R1, '42501')
    # Only the status column can change, and strangers' updates match no rows.
    check(f"update public.ride_requests set note = 'edited' where id = {active(R1)};", R1, '42501')
    r = check(set_status(R1, 'cancelled'), OTHER)
    assert 'cancelled' not in r.stdout.splitlines(), r.stdout
    # The driver can't cancel a rider's request (they decline instead).
    check(set_status(R1, 'cancelled'), DRIVER, '42501')
    check(set_status(R1, 'cancelled'), '', '42501', role='anon')
    assert statuses(R1) == 'pending'
    # The rider cancels their pending request. Seats are unchanged.
    check(set_status(R1, 'cancelled'), R1, rollback=False)
    assert statuses(R1) == 'cancelled' and seats_available() == '2', (statuses(R1), seats_available())
    # Cancelling again (double-click, second tab) is a no-op, not an error.
    check(f"update public.ride_requests set status = 'cancelled' where trip_id = '{trip}' and rider_id = '{R1}';", R1, rollback=False)
    assert statuses(R1) == 'cancelled' and seats_available() == '2', (statuses(R1), seats_available())
    # A cancellation is final, and the driver can't accept a cancelled request.
    check(f"update public.ride_requests set status = 'pending' where trip_id = '{trip}' and rider_id = '{R1}';", R1, '42501')
    check(f"update public.ride_requests set status = 'accepted' where trip_id = '{trip}' and rider_id = '{R1}';", DRIVER, '23514')
    # The rider can request again; a second active request is still refused.
    check(f"insert into public.ride_requests (trip_id, note) values ('{trip}', 'back on');", R1, rollback=False)
    check(f"insert into public.ride_requests (trip_id, note) values ('{trip}', 'twice');", R1, '23505')
    assert statuses(R1) == 'cancelled,pending', statuses(R1)

    # ---------- Cancelling an accepted seat gives it back ----------
    check(set_status(R1, 'accepted'), DRIVER, rollback=False)
    check(set_status(R2, 'accepted'), DRIVER, rollback=False)
    assert seats_available() == '-1', seats_available()  # full: out of search
    check(set_status(R3, 'accepted'), DRIVER, '23514')     # no overbooking
    check(set_status(R2, 'cancelled'), R2, rollback=False)
    assert seats_available() == '1', seats_available()     # back in search with the seat
    check(set_status(R3, 'accepted'), DRIVER, rollback=False)
    assert seats_available() == '-1'

    # ---------- Driver cancels a trip ----------
    trip2 = new_trip()
    sql(session(f"insert into public.ride_requests (trip_id, note) values ('{trip2}', '');", R1, rollback=False))
    sql(session(f"insert into public.ride_requests (trip_id, note) values ('{trip2}', '');", R2, rollback=False))
    check(set_status(R1, 'accepted', trip2), DRIVER, rollback=False)
    assert seats_available(trip2) == '1'
    # Only the driver can cancel: anyone else's update matches no rows.
    r = check(f"update public.trips set cancelled_at = now() where id = '{trip2}' returning id;", R1)
    assert trip2 not in r.stdout, r.stdout
    check(f"update public.trips set cancelled_at = now() where id = '{trip2}';", '', '42501', role='anon')
    # The driver cancels. The database time is stored, not the one sent.
    check(f"update public.trips set cancelled_at = '2000-01-01' where id = '{trip2}';", DRIVER, rollback=False)
    when = sql(f"select cancelled_at > now() - interval '1 minute' from public.trips where id = '{trip2}';").stdout.strip()
    assert when == 't', when
    assert seats_available(trip2) == '-1'  # gone from search
    # It can't be cancelled twice, un-cancelled, or edited.
    check(f"update public.trips set cancelled_at = null where id = '{trip2}';", DRIVER, '23514')
    check(f"update public.trips set price_per_seat = 10 where id = '{trip2}';", DRIVER, '23514')
    # No new requests or decisions on a cancelled trip.
    check(f"insert into public.ride_requests (trip_id, note) values ('{trip2}', '');", R3, '23514')
    check(set_status(R2, 'accepted', trip2), DRIVER, '23514')
    # Riders can still read the trip and their request, so My Trips shows it as cancelled.
    r = check(f"select cancelled_at is not null from public.trips where id = '{trip2}'; select status from public.ride_requests where trip_id = '{trip2}';", R1)
    assert r.stdout.splitlines()[-3:-1] == ['t', 'accepted'], r.stdout

    # ---------- Nothing can be cancelled after departure ----------
    trip3 = new_trip()
    sql(session(f"insert into public.ride_requests (trip_id, note) values ('{trip3}', '');", R1, rollback=False))
    sql(f"update public.trips set departure_at = now() - interval '1 hour' where id = '{trip3}';")
    check(set_status(R1, 'cancelled', trip3), R1, '23514')
    check(f"update public.trips set cancelled_at = now() where id = '{trip3}';", DRIVER, '23514')

    # ---------- Seat-fill KR skips cancelled trips ----------
    r = sql(f"select count(*) from public.kr_seat_fill_rate where trip_id in ('{trip}', '{trip2}', '{trip3}');")
    assert r.stdout.strip() == '2', r.stdout
    count += 1
    print(f'PASS: cancel request/trip applied and {count} checks passed in isolated PostgreSQL 18 with auth stubs. Not a live Supabase or browser integration test.')
finally:
    if started: call([BIN/'pg_ctl','-D',BASE/'data','stop','-m','fast'])
    shutil.rmtree(BASE)
