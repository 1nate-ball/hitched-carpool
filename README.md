# Hitch Carpool — Data Model and Backend

## App Summary
Hitch helps BYU students find carpools for weekend trips, visits home, and outdoor activities. Students without a car often need a ride, while drivers have empty seats and want to share travel costs. The app lets students browse destinations, view trip details, and see pickup locations and seat prices. Its screens also show seat requests, driver decisions, and group messages. Student profiles give potential travel companions a name, hometown, and short introduction. This assignment implements one complete feature: editing a profile and permanently saving the hometown, bio, and avatar color. The saved profile comes from a SQLite database and remains after both a browser refresh and a server restart. The remaining trip, account, verification, and chat interactions are clearly labeled prototype features rather than completed backend features.

## ERD
![Implemented database ERD with attributes and relationship cardinalities](docs/erd.png)

The database has five entities: **Users, Destinations, Trips, RideRequests, and Messages**. Each driver has many trips; each destination has many trips; each trip and each rider has many ride requests; each trip and each sender has many messages. Riders and trips therefore have a many-to-many relationship resolved by RideRequests. Accepted requests represent passengers; there is no duplicate passenger table. A unique `(TripID, RiderID)` constraint prevents duplicate requests. Foreign keys and checks enforce valid references, statuses, lengths, and positive seat counts.

The supplied team's [original ERD](docs/original-erd.png) is retained for reference. The implemented model adds AvatarColor and VehicleDescription because the screens use them. It omits PasswordHash because this slice uses a fixed classroom demo identity and does not implement password authentication. Uploading IDs, date of birth, email verification, live location permissions, real sign-in, and password reset remain future work; do not enter private documents into this prototype. All sample people are fictional.

The schema is in [database/schema.sql](database/schema.sql); reproducible sample data is in [database/seed.json](database/seed.json). First startup creates all five tables and adds multiple rows to every table. Later startups preserve existing data. Profile screens load from SQLite; the other screens still use the supplied JavaScript fixture data.

## Tech Stack

| Layer | Choice | Why it fits our team |
|---|---|---|
| Frontend | Existing HTML, CSS, vanilla JavaScript | Preserves the team's screens and avoids a framework migration. |
| Backend | Python 3 standard library HTTP server | Uses skills from our programming coursework; no packages or API keys required. |
| Database | SQLite, using Python's sqlite3 | A real relational database stored on disk, with inspectable tables and zero cloud setup fees. |
| Version control | Git / GitHub | One reproducible working version for the entire team. |

This local classroom stack has no provider free-tier limits. It is suitable for this assignment, not production hosting. It binds to `127.0.0.1` because profile editing intentionally uses the fixed Jordan Hale demo identity. A deployed multiuser version needs real server-side authentication, HTTPS, and persistent hosting storage. GitHub Pages alone cannot run this backend.

No real passwords or service keys are included. `.env`, database files, and generated caches are ignored by Git. `.env.example` documents optional environment variables; the server does not load `.env` automatically.

## How to Get It Running

1. Install **Python 3.10 or newer** and Git. Check with `python3 --version` on macOS/Linux or `py --version` on Windows.
2. Clone the repository and open its folder:
   ```sh
   git clone https://github.com/1nate-ball/hitched-carpool.git
   cd hitched-carpool
   ```
3. Start the app from the repository root:
   ```sh
   python3 server.py
   ```
   On Windows, use `py server.py`.
4. Open **http://127.0.0.1:8000** in your browser. The app opens directly to Jordan Hale's demo profile. No sign-in or cloud service setup is needed.
5. Leave that terminal running while using the app. Stop it with **Ctrl+C**. Start it again with the same command; saved data remains in `data/hitch.sqlite3`.

If port 8000 is occupied, run `PORT=8001 python3 server.py` on macOS/Linux and open http://127.0.0.1:8001. On Windows PowerShell, run `$env:PORT='8001'; py server.py`.

Do not double-click `public/index.html`: the backend must serve it for database requests to work. You may use a SQLite viewer to inspect `data/hitch.sqlite3`. To intentionally reset only the local demo, stop the server, delete that file, and restart; doing so discards your local profile changes.

Run verification from the repository root:
```sh
python3 -m unittest discover -s tests -v
```
The test uses a temporary database. It checks sample rows in every table, foreign keys, API saving and re-reading, preservation through startup, rejected invalid input, and cross-origin rejection.

## Verifying the Vertical Slice

1. Open http://127.0.0.1:8000 and choose **Edit profile**.
2. Change **Hometown** to `Boise, ID` and **Short bio** to a distinctive phrase such as `Ready for our next road trip!`. Optionally choose an avatar color.
3. Click **Save changes**. The button shows `Saving…` while JavaScript sends `PATCH /api/profile` to Python.
4. Python validates the fields, performs a parameterized SQLite `UPDATE`, commits the transaction, and returns the saved profile as JSON. The frontend displays that returned profile and the confirmation `Profile saved to database`.
5. Refresh the browser. `GET /api/profile` reads the stored row and displays your same hometown and bio.
6. For an additional durability check, stop and restart the server, then refresh again. The saved values remain.

To see the network request, open browser developer tools → Network, save again, and inspect `PATCH /api/profile` and its JSON response. If saving fails, the form stays open and displays an error instead of claiming success.

### Demo video and submission
[Watch or download the demo video](https://github.com/1nate-ball/hitched-carpool/raw/refs/heads/main/docs/demo.mp4). The recording shows only the profile feature: original profile → Edit profile → changed fields → Save changes → updated profile → browser refresh → same fields. It is generated from real browser interactions by the [verification workflow](.github/workflows/verify.yml), with captions explaining each step. The workflow also checks persistence after a full server restart and writes [verification evidence](docs/verification.json).

See the [rubric checklist](docs/rubric-checklist.md), [screen-to-data mapping](docs/screen-data-map.md), and [submission links](SUBMISSION.md).

The final assignment text entry must contain **two publicly accessible links**: the uploaded demo video and this GitHub repository's README. Verify both in a private/incognito browser window. The repository should be public. A local video file or local server URL is not a public submission link.
