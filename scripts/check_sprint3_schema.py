import pathlib, re, subprocess, tempfile, os
# Sprint 3 (Robbie): any destination and pickup identification (also loads every existing migration).
# Local PostgreSQL only, with synthetic Auth and Storage stubs. Never point this at a real database.
# Override POSTGRES_BIN if needed (e.g. /usr/lib/postgresql/16/bin).
BIN = pathlib.Path(os.environ.get('POSTGRES_BIN', '/Applications/Postgres.app/Contents/Versions/18/bin'))
BASE = pathlib.Path(tempfile.mkdtemp(prefix='hitch-sprint3-check-'))
MIGRATIONS = pathlib.Path(__file__).resolve().parents[1] / 'supabase/migrations'
DRIVER, RIDER, PENDING, OTHER = (f'{c*8}-{c*4}-4{c*3}-8{c*3}-{c*12}' for c in '1234')
def call(cmd, **kw):
    return subprocess.run([str(x) for x in cmd], text=True, capture_output=True, **kw)
r = call([BIN/'initdb', '-D', BASE/'data', '-A', 'trust', '--no-locale'])
assert r.returncode == 0, r.stderr
started = False
count = 0
try:
    r = call([BIN/'pg_ctl', '-D', BASE/'data', '-l', BASE/'server.log', '-o', f"-k {BASE} -h ''", 'start'])
    assert r.returncode == 0, r.stderr + r.stdout
    started = True
    def sql(body, code=0):
        r = call([BIN/'psql', '-h', BASE, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-At'], input=body)
        assert (r.returncode == 0) if code == 0 else (r.returncode != 0 and code in r.stderr), r.stdout + r.stderr
        return r
    users = ','.join(f"('{u}')" for u in (DRIVER, RIDER, PENDING, OTHER))
    sql(f"""create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{{}}');
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    insert into auth.users(id, email) values {','.join(f"('{u}', '{i}@byu.edu')" for i, u in enumerate((DRIVER, RIDER, PENDING, OTHER)))};
    -- Minimal Supabase Storage stand-in: just enough for the bucket row and policies.
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid default auth.uid());
    create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated;
    grant select, insert, update, delete on storage.objects to authenticated;
    grant execute on function storage.foldername(text) to authenticated;
    """)
    for path in sorted(MIGRATIONS.glob('*.sql')):
        sql(path.read_text())
    def session(body, who, rollback=True):
        return f"begin; set local role authenticated; select set_config('request.jwt.claim.sub','{who}',true); {body}" + (' rollback;' if rollback else ' commit;')
    def check(body, who, error=0, rollback=True):
        global count
        r = sql(session(body, who, rollback), error); count += 1
        return r.stdout.strip().splitlines()
    TAG = re.compile(r'^(BEGIN|ROLLBACK|COMMIT|SET|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$')
    def value(lines): return [l for l in lines if l and not TAG.match(l)][-1]

    # ---------- any destination ----------
    first = value(check("select id from public.find_or_create_destination('  Yellowstone   National Park ', 44.6, -110.5);", DRIVER, rollback=False))
    assert first.startswith('d-'), first
    again = value(check("select id from public.find_or_create_destination('yellowstone national park');", RIDER))
    assert again == first, 'same name (ignoring case/spaces) reuses the row'
    assert value(check("select name from public.destinations where id = '%s';" % first, OTHER)) == 'Yellowstone National Park'
    assert value(check("select id from public.find_or_create_destination('moab');", RIDER)) == 'moab', 'presets are reused'
    check("select public.find_or_create_destination('x');", DRIVER, '23514')
    check("select public.find_or_create_destination('Somewhere', 95, 10);", DRIVER, '23514')
    check("select public.find_or_create_destination('Somewhere', 40, null);", DRIVER, '23514')
    check("insert into public.destinations(id, name) values ('hack', 'Hack');", DRIVER, '42501')
    r = sql("begin; set local role anon; select public.find_or_create_destination('Nope'); rollback;", 'permission denied'); count += 1
    trip = value(check(f"insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat) values ('{first}', now()+interval '2 days', 'Helaman Halls', 'Old Faithful', 3, 40) returning id;", DRIVER, rollback=False))
    assert value(check(f"select count(*) from public.available_trips where destination_id = '{first}';", RIDER)) == '1', 'riders find trips to a new destination'

    # ---------- pickup identification ----------
    for rider in (RIDER, PENDING):
        check(f"insert into public.ride_requests (trip_id, note) values ('{trip}', 'hi');", rider, rollback=False)
    sql(f"update public.ride_requests set status = 'accepted' where trip_id = '{trip}' and rider_id = '{RIDER}';")
    code = value(check(f"insert into public.trip_pickup_details (trip_id, vehicle_make_model, vehicle_color, license_plate) values ('{trip}', ' Honda Civic ', 'Gray', 'abc 123') returning pickup_code;", DRIVER, rollback=False))
    assert re.fullmatch(r'\d{4}', code), code
    row = value(check(f"select vehicle_make_model || '|' || license_plate || '|' || pickup_code from public.trip_pickup_details where trip_id = '{trip}';", RIDER))
    assert row == f'Honda Civic|ABC 123|{code}', 'confirmed rider sees car, plate (uppercased), and code'
    for who in (PENDING, OTHER):
        assert value(check(f"select count(*) from public.trip_pickup_details where trip_id = '{trip}';", who)) == '0', 'pending/unrelated users see nothing'
    check(f"insert into public.trip_pickup_details (trip_id, pickup_code) values ('{trip}', '0000');", DRIVER, '42501')
    check(f"update public.trip_pickup_details set pickup_code = '0000' where trip_id = '{trip}';", DRIVER, '42501')
    # Upsert path used by the app keeps the original code and trip.
    after = value(check(f"insert into public.trip_pickup_details (trip_id, vehicle_make_model, vehicle_color, license_plate) values ('{trip}', 'Toyota Corolla', 'White', 'XYZ 9') on conflict (trip_id) do update set trip_id = excluded.trip_id, vehicle_make_model = excluded.vehicle_make_model, vehicle_color = excluded.vehicle_color, license_plate = excluded.license_plate returning pickup_code || '|' || vehicle_make_model;", DRIVER))
    assert after == f'{code}|Toyota Corolla', after
    lines = check(f"update public.trip_pickup_details set license_plate = 'HACK' where trip_id = '{trip}' returning trip_id;", RIDER)
    assert not any(trip in l for l in lines), 'riders cannot edit car details'
    check(f"insert into public.trip_pickup_details (trip_id) values ('{trip}');", OTHER, '42501')
    check(f"update public.trip_pickup_details set license_plate = 'bad plate!!' where trip_id = '{trip}';", DRIVER, '23514')
    assert value(check(f"select count(*) from information_schema.columns where table_name = 'available_trips' and column_name in ('license_plate','pickup_code');", OTHER)) == '0', 'plate/code never in the public trip view'
    print(f'PASS: {count} sprint 3 checks')
finally:
    if started: call([BIN/'pg_ctl', '-D', BASE/'data', 'stop', '-m', 'fast'])
