-- Test data for the seat-fill KR. Load into a scratch database, not data/hitch.sqlite3:
--   sqlite3 data/kr-test.sqlite3 < database/schema.sql
--   sqlite3 data/kr-test.sqlite3 < database/kr_seat_fill_test_seed.sql
-- Expected: kr_test_a = 0.75, kr_test_b = 0.3333, summary avg_fill_rate = 0.5417.
INSERT INTO Users VALUES
 ('kr_driver','kr_driver','Test','Driver','','',NULL,'#2F6B5E',1),
 ('kr_r1','kr_r1','Test','RiderOne','','',NULL,'#3B6EA8',1),
 ('kr_r2','kr_r2','Test','RiderTwo','','',NULL,'#B0562F',1),
 ('kr_r3','kr_r3','Test','RiderThree','','',NULL,'#7B4FA0',1),
 ('kr_r4','kr_r4','Test','RiderFour','','',NULL,'#A8456B',1);
INSERT INTO Destinations VALUES ('kr_dest','KR Test Destination','UT','Test');
INSERT INTO Trips VALUES
 ('kr_test_a','kr_driver','kr_dest','2026-01-10T09:00','Provo','SLC','Test car',4,10,0,NULL),
 ('kr_test_b','kr_driver','kr_dest','2026-01-11T09:00','Provo','SLC','Test car',3,10,0,NULL),
 ('kr_test_future','kr_driver','kr_dest','2099-01-01T09:00','Provo','SLC','Test car',4,10,0,NULL);
-- Trip A: 4 seats, 3 accepted (one rider booked 2 seats) -> 75%.
INSERT INTO RideRequests(TripID,RiderID,RequestStatus,RequestedSeats) VALUES
 ('kr_test_a','kr_r1','accepted',2),
 ('kr_test_a','kr_r2','accepted',1),
 ('kr_test_a','kr_r3','pending',1);
-- Trip B: 3 seats, 1 accepted + 1 declined -> 33%.
INSERT INTO RideRequests(TripID,RiderID,RequestStatus,RequestedSeats) VALUES
 ('kr_test_b','kr_r1','accepted',1),
 ('kr_test_b','kr_r4','declined',1);
-- Future trip with no requests: excluded from the summary average.
