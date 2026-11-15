import pathlib, subprocess, tempfile, os, shutil
# Seat fill rate stats (Objective 2 KR) for admins. Local PostgreSQL only, with Supabase-like stubs and
# every migration loaded. Never point this harness at an existing database. Override POSTGRES_BIN if needed.
BIN = pathlib.Path(os.environ.get('POSTGRES_BIN', '/Applications/Postgres.app/Contents/Versions/18/bin'))
BASE = pathlib.Path(tempfile.mkdtemp(prefix='hitch-stats-check-'))
MIGRATIONS = pathlib.Path(__file__).resolve().parents[1] / 'supabase/migrations'
ADMIN, DRIVER, R1, R2, R3, OTHER = (f'{c*8}-{c*4}-4{c*3}-8{c*3}-{c*12}' for c in '123456')
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
    users = ','.join(f"('{u}', 'u{i}@byu.edu', now())" for i, u in enumerate((ADMIN, DRIVER, R1, R2, R3, OTHER)))
    sql(f"insert into auth.users (id, email, email_confirmed_at) values {users};")
    for m in sorted(MIGRATIONS.glob('*.sql')):
        sql(m.read_text())
    count = 0
    def check(body, who, error=0, role='authenticated'):
        global count
        count += 1
        return sql(f"begin; set local role {role}; select set_config('request.jwt.claim.sub','{who}',true); {body} rollback;", error)
    stats = lambda: check('select * from public.seat_fill_stats();', ADMIN).stdout.splitlines()[-2].split('|')

    # ---------- Who can see it ----------
    sql(f"insert into public.admins (user_id) values ('{ADMIN}');")
    assert check('select public.is_admin();', ADMIN).stdout.splitlines()[-2] == 't'
    assert check('select public.is_admin();', OTHER).stdout.splitlines()[-2] == 'f'
    check('select * from public.seat_fill_stats();', OTHER, '42501')           # signed in, not an admin
    check('select * from public.seat_fill_stats();', '', '42501', role='anon')  # signed out
    check('select public.is_admin();', '', '42501', role='anon')
    # Nobody can read or change the admin list through the API, not even an admin.
    check('select * from public.admins;', ADMIN, '42501')
    check(f"insert into public.admins (user_id) values ('{OTHER}');", OTHER, '42501')
    check(f"delete from public.admins where user_id = '{ADMIN}';", ADMIN, '42501')
    # The per-trip KR views stay private.
    for view in ('kr_seat_fill_rate', 'kr_seat_fill_rate_summary'):
        check(f'select * from public.{view};', ADMIN, '42501')

    # ---------- Empty database ----------
    s = stats()
    assert s[:7] == ['0', '', '0', '0', '0', '0', '0'] and s[7] == '0.70', s

    # ---------- Same test data as database/kr_seat_fill_test_seed.sql ----------
    # A: departed, 4 seats, 3 accepted -> 0.75.  B: departed, 3 seats, 1 accepted + 1 declined -> 0.3333.
    # C: upcoming, 2 seats, 1 accepted (not in the KR).  D: departed but cancelled (left out entirely).
    def trip(name, seats):
        return sql(f"insert into public.trips (id, driver_id, destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat) values (gen_random_uuid(), '{DRIVER}', 'moab', now() + interval '1 day', '{name}', 'Moab', {seats}, 20) returning id;").stdout.split()[0]
    A, B, C, D = trip('A', 4), trip('B', 3), trip('C', 2), trip('D', 2)
    def req(t, rider, status):
        sql(f"insert into public.ride_requests (trip_id, rider_id, status) values ('{t}', '{rider}', '{status}');")
    for rider in (R1, R2, R3): req(A, rider, 'accepted')
    req(B, R1, 'accepted'); req(B, R2, 'declined'); req(C, R1, 'accepted'); req(D, R1, 'accepted')
    sql(f"update public.trips set cancelled_at = now() where id = '{D}';")
    sql(f"""alter table public.trips disable trigger check_trip_cancellation;
    update public.trips set departure_at = now() - interval '1 day' where id in ('{A}', '{B}', '{D}');
    alter table public.trips enable trigger check_trip_cancellation;""")
    s = stats()
    # departed_trips, avg_fill_rate, departed accepted/total, upcoming trips, upcoming accepted/total
    assert s[:7] == ['2', '0.5417', '4', '7', '1', '1', '2'], s
    count += 1

    # ---------- Live: a new accept shows up on the next call ----------
    req(C, R2, 'pending')
    sql(f"update public.ride_requests set status = 'accepted' where trip_id = '{C}' and rider_id = '{R2}';")
    s = stats()
    assert s[4:7] == ['1', '2', '2'], s
    # A rider cancelling an accepted seat lowers it again.
    sql(f"update public.ride_requests set status = 'cancelled' where trip_id = '{C}' and rider_id = '{R2}';")
    assert stats()[5] == '1'
    count += 1

    print(f'PASS: seat fill stats applied and {count} checks passed in isolated PostgreSQL 18 with Supabase-like stubs. Not a live Supabase or browser integration test.')
finally:
    if started: call([BIN/'pg_ctl','-D',BASE/'data','stop','-m','fast'])
    shutil.rmtree(BASE)
