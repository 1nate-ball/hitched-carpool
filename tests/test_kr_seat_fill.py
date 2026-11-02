import sqlite3
import unittest
from pathlib import Path

DATABASE=Path(__file__).resolve().parents[1]/'database'

class SeatFillRateTest(unittest.TestCase):
    def test_fill_rate_math(self):
        db=sqlite3.connect(':memory:')
        db.executescript((DATABASE/'schema.sql').read_text())
        db.executescript((DATABASE/'kr_seat_fill_test_seed.sql').read_text())
        rows={r[0]:r[1:] for r in db.execute('SELECT trip_id,accepted_seats,fill_rate,has_departed FROM kr_seat_fill_rate')}
        self.assertEqual(rows['kr_test_a'][:2],(3,0.75))
        self.assertEqual(rows['kr_test_b'][0],1)
        self.assertAlmostEqual(rows['kr_test_b'][1],1/3)
        self.assertEqual(rows['kr_test_future'],(0,0.0,0))
        self.assertEqual(db.execute('SELECT departed_trips,avg_fill_rate FROM kr_seat_fill_rate_summary').fetchone(),(2,0.5417))

    def test_fill_rate_capped_at_one(self):
        db=sqlite3.connect(':memory:')
        db.executescript((DATABASE/'schema.sql').read_text())
        db.executescript((DATABASE/'kr_seat_fill_test_seed.sql').read_text())
        db.execute("INSERT INTO RideRequests(TripID,RiderID,RequestStatus,RequestedSeats) VALUES ('kr_test_b','kr_r2','accepted',5)")
        self.assertEqual(db.execute("SELECT fill_rate FROM kr_seat_fill_rate WHERE trip_id='kr_test_b'").fetchone()[0],1.0)

if __name__=='__main__': unittest.main()
