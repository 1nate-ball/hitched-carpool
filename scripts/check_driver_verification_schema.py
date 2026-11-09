import pathlib, subprocess, tempfile, os, shutil
# Local PostgreSQL only. Creates synthetic Auth stubs in a temporary database.
# Never point this harness at an existing database. Override POSTGRES_BIN if needed.
BIN = pathlib.Path(os.environ.get('POSTGRES_BIN', '/Applications/Postgres.app/Contents/Versions/18/bin'))
BASE = pathlib.Path(tempfile.mkdtemp(prefix='hitch-verify-check-'))
MIGRATIONS = pathlib.Path(__file__).resolve().parents[1] / 'supabase/migrations'
# id suffix -> (email, confirmed?, expected verified?)
USERS = {
    '1': ('driver@byu.edu', True, True),
    '2': ('student@mail.byu.edu', True, True),       # subdomain, same rule as the sign-up form
    '3': ('LOUD@BYU.EDU', True, True),               # case-insensitive
    '4': ('unconfirmed@byu.edu', False, False),      # never clicked the link
    '5': ('someone@gmail.com', True, False),         # not a BYU address
    '6': ('trick@byu.edu.example.com', True, False), # byu.edu is not the real domain
    '7': ('trick@notbyu.edu', True, False),
}
uid = lambda k: f'{k*8}-{k*4}-4{k*3}-8{k*3}-{k*12}'
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
    values = ','.join(f"('{uid(k)}','{e}',{'now()' if c else 'null'})" for k, (e, c, _) in USERS.items())
    sql(f"""create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    insert into auth.users values {values};
    """)
    for name in ('20261027000100_post_a_trip.sql', '20261104000100_request_a_seat.sql',
                 '20261106000100_trip_locations_search_ownership.sql', '20261108000100_driver_verification.sql'):
        sql((MIGRATIONS/name).read_text())
    def session(body, who, role='authenticated', rollback=True):
        return f"begin; set local role {role}; select set_config('request.jwt.claim.sub','{who}',true); {body}" + (' rollback;' if rollback else ' commit;')
    post = "insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat) values ('moab', now()+interval '1 day', 'Helaman Halls', 'Moab', 3, 25) returning id;"
    count = 0
    def check(body, who, error=0, role='authenticated'):
        global count
        r = sql(session(body, who, role), error); count += 1
        return r
    # Posting a trip: only verified users.
    for k, (email, _, verified) in USERS.items():
        check(post, uid(k), 0 if verified else '42501')
    # The verification function agrees with the table above.
    for k, (email, _, verified) in USERS.items():
        r = check(f"select public.is_verified_user('{uid(k)}');", uid('1'))
        assert r.stdout.splitlines()[-2] == ('t' if verified else 'f'), (email, r.stdout)
    # Batch lookup returns only id + boolean, never emails.
    ids = ','.join(f"'{uid(k)}'" for k in USERS)
    r = check(f"select * from public.verification_status(array[{ids}]::uuid[]) order by 1;", uid('5'))
    rows = [l for l in r.stdout.splitlines() if '|' in l]
    assert len(rows) == len(USERS) and all(l.count('|') == 1 and '@' not in l for l in rows), rows
    # Signed-out callers can't use either function or read the KR views.
    check(f"select public.is_verified_user('{uid('1')}');", '', '42501', role='anon')
    check(f"select * from public.verification_status(array['{uid('1')}']::uuid[]);", '', '42501', role='anon')
    for view in ('kr_driver_verification', 'kr_driver_verification_summary'):
        check(f'select * from public.{view};', uid('1'), '42501')
        check(f'select * from public.{view};', '', '42501', role='anon')
    # Confirming the email later unlocks posting.
    check(f"reset role; update auth.users set email_confirmed_at = now() where id = '{uid('4')}'; set local role authenticated; {post}", uid('4'))
    # KR math, as postgres (SQL Editor): 3 verified drivers via the app, plus one unverified driver
    # whose trip predates the rule (inserted directly), so 3 of 4 = 75.0%.
    for k in ('1', '2', '3'):
        sql(session(post, uid(k), rollback=False))
    sql(post.replace(') values (', ', driver_id) values (').replace(", 25)", f", 25, '{uid('5')}')"))
    r = sql('select drivers, verified_drivers, verified_rate from public.kr_driver_verification_summary;')
    assert '4|3|75.0' in r.stdout.splitlines(), r.stdout
    r = sql(f"select is_verified, trips_posted from public.kr_driver_verification where driver_id = '{uid('5')}';")
    assert 'f|1' in r.stdout.splitlines(), r.stdout
    count += 1
    print(f'PASS: driver verification applied and {count} checks passed in isolated PostgreSQL 18 with auth stubs. Not a live Supabase or browser integration test.')
finally:
    if started: call([BIN/'pg_ctl','-D',BASE/'data','stop','-m','fast'])
    shutil.rmtree(BASE)
