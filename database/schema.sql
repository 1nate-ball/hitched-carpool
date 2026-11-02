CREATE TABLE IF NOT EXISTS Users (
 UserID TEXT PRIMARY KEY, Username TEXT NOT NULL UNIQUE,
 FirstName TEXT NOT NULL, LastName TEXT NOT NULL,
 Hometown TEXT NOT NULL DEFAULT '', Bio TEXT NOT NULL DEFAULT '' CHECK(length(Bio)<=160),
 ProfilePhotoURL TEXT, AvatarColor TEXT NOT NULL,
 IsVerified INTEGER NOT NULL CHECK(IsVerified IN (0,1))
);
CREATE TABLE IF NOT EXISTS Destinations (
 DestinationID TEXT PRIMARY KEY, DestinationName TEXT NOT NULL,
 State TEXT NOT NULL, Category TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS Trips (
 TripID TEXT PRIMARY KEY, DriverID TEXT NOT NULL REFERENCES Users(UserID),
 DestinationID TEXT NOT NULL REFERENCES Destinations(DestinationID),
 DepartureDateTime TEXT NOT NULL, PickupLocation TEXT NOT NULL, DropoffLocation TEXT NOT NULL,
 VehicleDescription TEXT NOT NULL, TotalSeats INTEGER NOT NULL CHECK(TotalSeats>0),
 PricePerSeat REAL NOT NULL CHECK(PricePerSeat>=0),
 HasReturnTrip INTEGER NOT NULL CHECK(HasReturnTrip IN (0,1)), ReturnDateTime TEXT,
 CHECK((HasReturnTrip=0 AND ReturnDateTime IS NULL) OR (HasReturnTrip=1 AND ReturnDateTime IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS RideRequests (
 RequestID INTEGER PRIMARY KEY, TripID TEXT NOT NULL REFERENCES Trips(TripID),
 RiderID TEXT NOT NULL REFERENCES Users(UserID),
 RequestStatus TEXT NOT NULL CHECK(RequestStatus IN ('pending','accepted','declined')),
 RequestMessage TEXT NOT NULL DEFAULT '', RequestedSeats INTEGER NOT NULL DEFAULT 1 CHECK(RequestedSeats>0),
 RequestedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(TripID,RiderID)
);
CREATE TABLE IF NOT EXISTS Messages (
 MessageID INTEGER PRIMARY KEY, TripID TEXT NOT NULL REFERENCES Trips(TripID),
 SenderID TEXT NOT NULL REFERENCES Users(UserID), MessageText TEXT NOT NULL,
 SentAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_riderequests_tripid ON RideRequests(TripID);
-- KR: posted trips average 70% of seats filled. Accepted seats per trip, capped at 100%.
CREATE VIEW IF NOT EXISTS kr_seat_fill_rate AS
SELECT t.TripID AS trip_id, t.TotalSeats AS seats_total,
 COALESCE(SUM(CASE WHEN r.RequestStatus='accepted' THEN r.RequestedSeats END),0) AS accepted_seats,
 MIN(1.0, COALESCE(SUM(CASE WHEN r.RequestStatus='accepted' THEN r.RequestedSeats END),0)*1.0/t.TotalSeats) AS fill_rate,
 datetime(t.DepartureDateTime) <= datetime('now','localtime') AS has_departed
FROM Trips t LEFT JOIN RideRequests r ON r.TripID=t.TripID
GROUP BY t.TripID;
-- Mean of per-trip fill rates, departed trips only so new trips don't drag it down.
CREATE VIEW IF NOT EXISTS kr_seat_fill_rate_summary AS
SELECT COUNT(*) AS departed_trips, ROUND(AVG(fill_rate),4) AS avg_fill_rate
FROM kr_seat_fill_rate WHERE has_departed=1;
