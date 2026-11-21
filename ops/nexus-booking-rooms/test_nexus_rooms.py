"""NEXUS Rooms reservations: conflict rule, transitions and concurrency on a throwaway SQLite database.
Run next to the NEXUS Booking release:  python3 -m unittest test_nexus_rooms -v"""
import os
import tempfile
import threading
import unittest
from datetime import date, timedelta
from pathlib import Path

import nexus_rooms_http as R

D = lambda n: (date.today() + timedelta(days=n)).isoformat()
ROOM = lambda n: {'unitKey': f'room:{1000 + n}', 'unitLabel': f'Room {n}', 'span': [n * 100, n * 100 + 100]}
WHOLE = {'unitKey': 'whole', 'unitLabel': 'Whole apartment', 'span': [0, 1000000]}
GUEST = {'name': 'Mia Synthetic', 'email': 'mia@example.test'}


class Rooms(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / 'booking.sqlite'
        R.ensure_table(self.db)

    def tearDown(self):
        self.tmp.cleanup()

    def req(self, unit, a, b, ref='2906-9901', **extra):
        return R.create_request({'propertyRef': ref, **unit, 'checkIn': D(a), 'checkOut': D(b), 'guest': GUEST, **extra}, self.db)

    def act(self, stay, action, ref='2906-9901', **extra):
        return R.decide(stay['id'], {'propertyRef': ref, 'action': action, 'actor': 'test', **extra}, self.db)

    def test_requests_never_block_and_viewings_are_not_tenancies(self):
        s1, a = self.req(ROOM(2), 10, 40)
        s2, b = self.req(ROOM(2), 20, 50)
        s3, c = self.req(WHOLE, 5, 60)
        self.assertEqual((s1, s2, s3), (201, 201, 201))
        v, view = R.create_request({'propertyRef': '2906-9901', **ROOM(2), 'kind': 'viewing', 'checkIn': D(12), 'guest': GUEST}, self.db)
        self.assertEqual(v, 201); self.assertEqual(view['stay']['kind'], 'viewing')
        self.assertEqual(R.availability('2906-9901', None, None, self.db)['blocks'], [])
        # confirming a viewing never blocks anything
        self.assertEqual(self.act(view['stay'], 'confirm')[0], 200)
        self.assertEqual(R.availability('2906-9901', None, None, self.db)['blocks'], [])

    def test_whole_apartment_blocks_every_room_and_a_room_blocks_the_whole(self):
        _, whole = self.req(WHOLE, 30, 90)
        self.assertEqual(self.act(whole['stay'], 'confirm')[0], 200)
        for n in (1, 2, 3):
            st, out = self.req(ROOM(n), 60, 120)
            self.assertEqual(st, 409, n); self.assertIn('whole apartment', out['message'])
        st, ok = self.req(ROOM(2), 90, 150)  # starts on the check-out day: allowed
        self.assertEqual(st, 201)
        # a held room blocks confirming the whole apartment over those dates
        _, room = self.req(ROOM(1), 100, 200)
        _, whole2 = self.req(WHOLE, 150, 160)          # both only requested: nothing blocks yet
        self.assertEqual(self.act(room['stay'], 'hold', holdHours=24)[0], 200)
        st, late = self.req(WHOLE, 150, 160)
        self.assertEqual(st, 409, 'a new whole-apartment request over a held room is refused at once')
        st, out = self.act(whole2['stay'], 'confirm')
        self.assertEqual(st, 409); self.assertIn('Room 1', out['message'])
        # other rooms stay independent
        _, r3 = self.req(ROOM(3), 100, 200)
        self.assertEqual(self.act(r3['stay'], 'confirm')[0], 200)
        # releasing the room frees the whole apartment only if nothing else blocks it
        self.assertEqual(self.act(room['stay'], 'decline')[0], 200)
        self.assertEqual(self.act(whole2['stay'], 'confirm')[0], 409, 'room 3 still confirmed over those dates')
        self.assertEqual(self.act(r3['stay'], 'cancel')[0], 200)
        self.assertEqual(self.act(whole2['stay'], 'confirm')[0], 200)

    def test_rooms_do_not_conflict_with_each_other_and_other_homes_are_separate(self):
        for n in (1, 2, 3):
            _, s = self.req(ROOM(n), 10, 100)
            self.assertEqual(self.act(s['stay'], 'confirm')[0], 200)
        _, other = self.req(WHOLE, 10, 100, ref='2906-9902')
        self.assertEqual(self.act(other['stay'], 'confirm', ref='2906-9902')[0], 200)
        blocks = R.availability('2906-9901', None, None, self.db)['blocks']
        self.assertEqual(sorted(b['unitKey'] for b in blocks), ['room:1001', 'room:1002', 'room:1003'])

    def test_transitions_holds_expire_and_wrong_home_is_refused(self):
        _, s = self.req(ROOM(1), 10, 40)
        self.assertEqual(self.act(s['stay'], 'cancel')[0], 409)
        self.assertEqual(self.act(s['stay'], 'hold', ref='2906-0000')[0], 404, 'a stay is only decided for its own home')
        st, held = self.act(s['stay'], 'hold', holdHours=1)
        self.assertEqual(held['stay']['status'], 'held')
        # an expired hold stops blocking
        with R.booking_db.connection(self.db) as db:
            db.execute("UPDATE room_stays SET hold_expires_at='2000-01-01T00:00:00Z' WHERE id=?", (s['stay']['id'],))
        _, again = self.req(ROOM(1), 20, 30)
        self.assertEqual(self.act(again['stay'], 'confirm')[0], 200)
        self.assertEqual(R.list_stays('2906-9901', self.db)['stays'][0]['status'], 'expired')

    def test_validation_and_idempotency(self):
        with self.assertRaises(ValueError):
            self.req(ROOM(1), -3, 10)
        with self.assertRaises(ValueError):
            R.create_request({'propertyRef': '2906-9901', **ROOM(1), 'checkIn': D(5), 'checkOut': D(9), 'guest': {'name': 'No Contact'}}, self.db)
        with self.assertRaises(ValueError):
            R.create_request({'propertyRef': '2906-9901', 'unitKey': 'room:1', 'span': [150, 250], 'checkIn': D(5), 'checkOut': D(9), 'guest': GUEST}, self.db)
        s1, a = self.req(ROOM(1), 5, 9, idempotencyKey='k-123456789')
        s2, b = self.req(ROOM(1), 5, 9, idempotencyKey='k-123456789')
        self.assertEqual((s1, s2), (201, 200)); self.assertEqual(a['stay']['id'], b['stay']['id'])
        self.assertEqual(len(R.list_stays('2906-9901', self.db)['stays']), 1)

    def test_concurrent_confirmations_only_one_wins(self):
        stays = [self.req(WHOLE if i % 2 else ROOM(2), 10, 40)[1]['stay'] for i in range(8)]
        results = []
        barrier = threading.Barrier(len(stays))

        def go(s):
            barrier.wait()
            results.append(self.act(s, 'confirm')[0])
        threads = [threading.Thread(target=go, args=(s,)) for s in stays]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(results.count(200), 1, results)
        self.assertEqual(results.count(409), len(stays) - 1)
        confirmed = [x for x in R.list_stays('2906-9901', self.db)['stays'] if x['status'] == 'confirmed']
        self.assertEqual(len(confirmed), 1)

    def test_signature(self):
        sig = R.signature('s' * 40, '1700000000', 'POST', '/api/nexus-booking/rooms/requests', b'{}')
        self.assertEqual(sig, R.signature('s' * 40, '1700000000', 'POST', '/api/nexus-booking/rooms/requests', b'{}'))
        self.assertNotEqual(sig, R.signature('s' * 40, '1700000000', 'POST', '/api/nexus-booking/rooms/requests', b'{"x":1}'))


if __name__ == '__main__':
    unittest.main()
