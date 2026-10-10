# Assignment requirement checklist

| Requirement | Deliverable / evidence |
|---|---|
| ERD: at least four entities with attributes | Five entities in `docs/erd.png`, embedded in the README. |
| Every relationship labeled with cardinality | Six relationships labeled 1:N; rider/trip N:M explained through RideRequests. |
| Screens trace to entities and attributes | `docs/screen-data-map.md`. |
| Stack choice and rationale | README → Tech Stack. Python standard library and SQLite keep setup simple and free. |
| At least four database tables | `database/schema.sql` defines Users, Destinations, Trips, RideRequests, Messages. |
| Sample rows in every table | First startup seeds 10 users, 8 destinations, 13 trips, 15 ride requests, and 6 messages. Browser verification reports actual counts in `docs/verification.json`. |
| Existing action sends request to backend | Edit profile → Save changes sends PATCH `/api/profile`. |
| Backend updates database | Parameterized UPDATE in `server.py`; committed before returning success. |
| Returned value displayed by frontend | Frontend assigns the returned profile and renders it. |
| Change survives refresh | GET `/api/profile` reads SQLite; browser recording demonstrates refresh persistence. |
| Passwords / keys kept out of shared code | No runtime secrets required; `.env` ignored, `.env.example` contains no secrets. |
| README: App Summary, 5–8 sentences | Eight sentences under App Summary. |
| README: ERD | Embedded PNG plus original team diagram. |
| README: Tech Stack | Layer table, rationale, costs and limitations. |
| README: How to Get It Running | Exact clone URL, startup command, app URL, Windows instructions. |
| README: Verifying the Vertical Slice | Exact click/save/refresh steps, plus restart check. |
| Video ≤2 minutes, shows action/change/refresh | `docs/demo.mp4`: real browser recording of profile editing, with explanatory captions. |
| Public GitHub repository and submission links | `SUBMISSION.md` contains the two assignment links. |

The working backend scope is profile saving. Other prototype actions are explicitly labeled. This is a local classroom demo, not a deployed multiuser service; hosting is not required by this assignment.
