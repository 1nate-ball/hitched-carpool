# Women-only ride option: proposed flow

**Trello card:** Ride preferences: Define and test a women-only ride option
**Owner:** Robbie McVey · **Status:** proposal for team review, not yet built

> This card defines the flow only. The team needs to agree on it and run a short test with riders before anyone writes an implementation card.

## The feedback

> "safety features or selectors for female only rides."

Riders, especially women traveling with strangers, want more control over who they ride with.

## Principles

1. **Opt-in.** A driver chooses to offer a women-only trip, and a rider chooses to look for one. Nobody is filtered without asking.
2. **Self-described, never inferred.** We never guess anyone's gender from their name, photo, or anything else. A user states it once in their profile settings, and it's private.
3. **Be honest about what it is.** Hitch doesn't verify gender. "Women-only" is a preference everyone agrees to, not a guarantee. The app must never say a ride is "safe" or "verified".
4. **Collect as little as possible.** We store one optional private setting and nothing else (no ID documents, no birth date).

## Proposed flow

### 1. Profile setting (private)

The Edit profile page gets an optional new field:

> **Ride preference eligibility** (private)
> ☐ I'm a woman and want to offer or join women-only trips
> *Only used to show or hide women-only trips. Never shown on your profile.*

- If the box is unchecked (the default), nothing changes for that user.
- It's stored privately, and other users can't read it through the API.

### 2. Driver posts a women-only trip

This only shows up on Post a Trip if the driver checked the profile box.

> ☐ **Women-only trip.** Only riders who chose this option in their profile can request a seat.

- On cards and Trip Detail, the trip gets a small neutral tag: **Women-only**.

### 3. Rider finds and requests

- **Eligible riders** see women-only trips mixed in with the rest, tagged, plus a filter chip: **Women-only trips**.
- **Everyone else** doesn't see women-only trips in search. This avoids a "you can't request this" dead end, and it avoids telling anyone why.
- The database enforces this (an RLS check on `ride_requests`), not just the button.

### 4. Wording (plain language)

| Where | Text |
|---|---|
| Tag on trip | Women-only |
| Trip Detail note | The driver has limited this trip to riders who chose the women-only option. Hitch does not verify gender or identity. |
| Filter chip | Women-only trips |
| Profile help text | Only used to show or hide women-only trips. Never shown on your profile. |

## Edge cases to decide as a team

| Case | Proposed answer |
|---|---|
| A user unchecks the box after being accepted on a women-only trip | They keep the seat. New requests follow the new setting. |
| A driver switches an existing trip to women-only after accepting other riders | Not allowed once a request is accepted, so nobody gets kicked off. |
| Someone checks the box dishonestly | It can't be prevented without ID checks, which are out of scope and a privacy cost. Rely on reporting and on driver Accept/Decline, and say so plainly in the wording above. |
| Non-binary users | Ask testers about this. One option is to word it as "women and non-binary riders". The team decides after feedback. |
| A trip has no eligible riders | Normal "no rides found" empty state. Nothing special. |

## Data model (for the future implementation card)

- `profiles_private (user_id pk, women_only_eligible boolean default false)`: readable only by its owner.
- `trips.women_only boolean default false`: the driver can set it only if they're eligible.
- An RLS check on `ride_requests` insert, plus a filter on the `available_trips` view, so ineligible users can't see or request these trips.

## Test plan (5–6 representative users)

1. Show the profile checkbox and the trip tag. Ask: "What do you think this does? Who can see it?"
2. Ask women testers whether they would use it, and whether the wording feels honest without sounding scary.
3. Ask other testers whether hiding these trips from them is OK, or whether it's confusing.
4. Record answers in the team notes, adjust the wording, then size an implementation card (estimated 5–8 points).

## Out of scope

ID verification, gender verification, and any claim of guaranteed safety.
