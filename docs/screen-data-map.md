# Screen-to-data mapping

| Screen / information | Entity and attributes | Current implementation |
|---|---|---|
| Profile / edit profile: identity | Users.UserID, Username, FirstName, LastName | Fixed demo identity loaded from SQLite. |
| Profile / edit profile: hometown, bio, avatar | Users.Hometown, Bio, AvatarColor, ProfilePhotoURL | Hometown, bio, and color save to SQLite; sample avatars only. |
| Verification badge | Users.IsVerified | Seeded demo status; real identity review is future work. |
| Destination browsing: name, state, category | Destinations.DestinationName, State, Category | Seeded table and prototype browsing fixtures. |
| Destination cards: illustration, estimated drive/cost, aliases | Frontend presentation/search metadata keyed by DestinationID | Static sample artwork and estimates; not authoritative trip prices. |
| Trip results / details / post form | Trips.DriverID, DestinationID, DepartureDateTime, PickupLocation, DropoffLocation, VehicleDescription, TotalSeats, PricePerSeat, HasReturnTrip, ReturnDateTime | Seeded tables; interactive trip changes remain in-memory prototype behavior. |
| Seats available | Trips.TotalSeats minus accepted RideRequests.RequestedSeats | Derived value, not an independently stored attribute. |
| My trips / manage requests / request seat | RideRequests.TripID, RiderID, RequestStatus, RequestMessage, RequestedSeats, RequestedAt | Seeded relational sample rows. Driver is Trips.DriverID. |
| Group chat: sender, text, time | Messages.TripID, SenderID, MessageText, SentAt | Seeded relational sample rows; sending remains a prototype interaction. |
| Search/filter controls | Temporary UI state (destination, date, max price, return trip) | Query criteria, not entities. |

The earlier sign-up, sign-in, and password-reset forms are not active in this classroom build. Authentication, email, DOB, private verification uploads, and real location permissions are future scope. The app opens directly to the fixed sample profile; it makes no claim to authenticate a BYU student.

All six foreign-key relationships are one-to-many from parent to child. A parent may have zero children; each child has exactly one referenced parent. Users and Trips also have a conceptual many-to-many rider relationship implemented through RideRequests.
