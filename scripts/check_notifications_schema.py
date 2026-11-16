import pathlib, subprocess, tempfile, os, shutil
# In-app notifications (20261118000100_notifications.sql). Local PostgreSQL only, with Supabase-like stubs and
# every migration loaded. Never point this harness at an existing database. Override POSTGRES_BIN if needed.
BIN = pathlib.Path(os.environ.get('POSTGRES_BIN', '/Applications/Postgres.app/Contents/Versions/18/bin'))
BASE = pathlib.Path(tempfile.mkdtemp(prefix='hitch-notify-check-'))
MIGRATIONS = pathlib.Path(__file__).resolve().parents[1] / 'supabase/migrations'
DRIVER, R1, R2, OTHER = (f'{c*8}-{c*4}-4{c*3}-8{c*3}-{c*12}' for c in '1234')
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
        r = call([BIN/'psql','-h',BASE,'-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-qAt'], input=body)
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
    names = {DRIVER:'Dana Driver', R1:'Riley Rider', R2:'Sam Second', OTHER:'Olive Other'}
    users = ','.join(f"""('{u}', 'u{i}@byu.edu', now(), '{{"full_name":"{n}"}}')""" for i, (u, n) in enumerate(names.items()))
    sql(f"insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values {users};")
    for m in sorted(MIGRATIONS.glob('*.sql')):
        sql(m.read_text())
    sql("".join(f"update public.profiles set full_name = '{n}' where id = '{u}';" for u, n in names.items()))
    count = 0
    def as_user(body, who, error=0, role='authenticated'):
        """Runs as a signed-in API user and keeps the change (commit), like a real request."""
        global count
        count += 1
        return sql(f"begin; set local role {role}; select from set_config('request.jwt.claim.sub','{who}',true); {body} commit;", error)
    def rows(who):
        out = as_user("select kind, coalesce(other_name,''), destination_id, (read_at is not null) from public.my_notifications();", who).stdout
        return [line.split('|') for line in out.splitlines() if '|' in line]
    def total():
        return int(sql("select count(*) from public.notifications;").stdout.split()[0])

    trip = sql(f"""insert into public.trips (driver_id, destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat)
      values ('{DRIVER}', 'moab', now() + interval '3 days', 'WILK', 'Moab', 1, 20) returning id;""").stdout.split()[0]

    # ---------- A saved seat request notifies the driver, and only the driver ----------
    as_user(f"insert into public.ride_requests (trip_id, note) values ('{trip}', 'hi');", R1)
    assert rows(DRIVER) == [['seat_requested', 'Riley Rider', 'moab', 'f']], rows(DRIVER)
    assert rows(R1) == [] and rows(OTHER) == [], (rows(R1), rows(OTHER))
    req1 = sql(f"select id from public.ride_requests where rider_id = '{R1}';").stdout.split()[0]

    # ---------- A refused request creates nothing ----------
    as_user(f"insert into public.ride_requests (trip_id, note) values ('{trip}', 'again');", R1, '23505')   # duplicate request
    as_user(f"insert into public.ride_requests (trip_id, note) values ('{trip}', 'mine');", DRIVER, '42501') # own trip
    assert total() == 1, total()

    # ---------- Accept notifies the rider with the driver's name ----------
    as_user(f"update public.ride_requests set status = 'accepted' where id = '{req1}';", DRIVER)
    assert rows(R1) == [['request_accepted', 'Dana Driver', 'moab', 'f']], rows(R1)

    # ---------- A refused decision creates nothing: full trip, rider deciding, already decided ----------
    as_user(f"insert into public.ride_requests (trip_id, note) values ('{trip}', '');", R2)
    req2 = sql(f"select id from public.ride_requests where rider_id = '{R2}';").stdout.split()[0]
    assert total() == 3, total()
    as_user(f"update public.ride_requests set status = 'accepted' where id = '{req2}';", DRIVER, 'full')
    as_user(f"update public.ride_requests set status = 'accepted' where id = '{req2}';", R2, '42501')
    as_user(f"update public.ride_requests set status = 'declined' where id = '{req1}';", DRIVER, 'already')
    assert total() == 3 and rows(R2) == [], (total(), rows(R2))

    # ---------- Decline notifies the rider ----------
    as_user(f"update public.ride_requests set status = 'declined' where id = '{req2}';", DRIVER)
    assert rows(R2) == [['request_declined', 'Dana Driver', 'moab', 'f']], rows(R2)

    # ---------- No duplicate alerts for the same event ----------
    as_user(f"update public.ride_requests set status = 'declined' where id = '{req2}';", DRIVER)  # same status again: no change
    sql(f"insert into public.notifications (recipient_id, kind, request_id, trip_id) values ('{R2}', 'request_declined', '{req2}', '{trip}');", 'notifications_one_per_event')
    assert total() == 4, total()
    count += 1

    # ---------- Cancelling a request isn't an alert in this card ----------
    as_user(f"update public.ride_requests set status = 'cancelled' where id = '{req1}';", R1)
    assert total() == 4, total()

    # ---------- Other users can't read, write, or mark them ----------
    as_user("select count(*) from public.notifications;", OTHER)
    assert as_user("select count(*) from public.notifications;", OTHER).stdout.split()[-1] == '0'
    assert as_user("select count(*) from public.notifications;", R1).stdout.split()[-1] == '1'  # only their own
    as_user(f"insert into public.notifications (recipient_id, kind, request_id, trip_id) values ('{OTHER}', 'seat_requested', '{req1}', '{trip}');", OTHER, '42501')
    as_user("update public.notifications set read_at = now();", R1, '42501')
    as_user("delete from public.notifications;", R1, '42501')
    as_user("select * from public.my_notifications();", '', '42501', role='anon')
    as_user("select public.mark_notifications_read();", '', '42501', role='anon')
    n = sql(f"select id from public.notifications where recipient_id = '{DRIVER}' order by created_at limit 1;").stdout.split()[0]
    assert as_user(f"select public.mark_notifications_read(array['{n}']::uuid[]);", OTHER).stdout.split()[-1] == '0'
    assert rows(DRIVER)[0][3] == 'f', rows(DRIVER)

    # ---------- Mark read: one, then all; it stays read ----------
    assert as_user(f"select public.mark_notifications_read(array['{n}']::uuid[]);", DRIVER).stdout.split()[-1] == '1'
    assert [r[3] for r in rows(DRIVER)] == ['f', 't'], rows(DRIVER)  # newest first: R2's request still unread
    assert as_user("select public.mark_notifications_read();", DRIVER).stdout.split()[-1] == '1'
    assert as_user("select public.mark_notifications_read();", DRIVER).stdout.split()[-1] == '0'
    assert all(r[3] == 't' for r in rows(DRIVER)) and rows(R1)[0][3] == 'f', (rows(DRIVER), rows(R1))

    # ---------- A rider who cancelled can request again: that's a new event ----------
    sql(f"update public.trips set total_seats = 3 where id = '{trip}';")
    as_user(f"insert into public.ride_requests (trip_id, note) values ('{trip}', 'back on');", R1)
    assert [r[0] for r in rows(DRIVER)].count('seat_requested') == 3, rows(DRIVER)

    print(f'PASS: notifications applied and {count} checks passed in isolated PostgreSQL 18 with Supabase-like stubs. Not a live Supabase or browser integration test.')
finally:
    if started: call([BIN/'pg_ctl','-D',BASE/'data','stop','-m','fast'])
    shutil.rmtree(BASE)
