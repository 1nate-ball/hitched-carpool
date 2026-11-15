import io
import json
import threading
import unittest
from datetime import datetime
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import ai_trip_draft as ai
import server

UID = '11111111-1111-4111-8111-111111111111'
NOW = datetime(2026,11,15,12,tzinfo=ai.ZONE)


def fields(**values):
    return {**dict.fromkeys(ai.FIELDS), **values}


class ExtractionTest(unittest.TestCase):
    def test_bounds_missing_fields_and_unknown_output(self):
        result = ai.validate_draft(fields(origin_city='Provo', destination_name='Moab', seats=3, price_per_seat=25), NOW)
        self.assertEqual(result['fields']['seats'],3)
        self.assertIn('departure date',result['missing'])
        result = ai.validate_draft(fields(seats=True,price_per_seat=151,origin_city='x'*81,departure_date='2026-06-31',departure_time='25:00'), NOW)
        self.assertTrue(all(v is None for v in result['fields'].values()))
        with self.assertRaises(ai.DraftError):
            ai.validate_draft({'driver_id':'someone-else'},NOW)

    def test_return_order_dst_and_past_dates_are_not_applied(self):
        result = ai.validate_draft(fields(departure_date='2026-11-20',departure_time='16:00',return_requested=True,return_date='2026-11-20',return_time='15:00'),NOW)
        self.assertEqual(result['fields']['departure_time'],'16:00')
        self.assertIsNone(result['fields']['return_time'])
        for day,clock in [('2027-03-14','02:30'),('2027-11-07','01:30')]:
            self.assertIsNone(ai.validate_draft(fields(departure_date=day,departure_time=clock),NOW)['fields']['departure_time'])
        self.assertIsNone(ai.validate_draft(fields(departure_date='2020-01-01'),NOW)['fields']['departure_date'])
        self.assertIsNone(ai.validate_draft(fields(return_requested=False,return_date='2026-11-22'),NOW)['fields']['return_date'])

    def test_description_rejects_extra_fields_and_size(self):
        for value in [{}, {'description':'short'}, {'description':'x'*2001}, {'description':'A sufficiently long description','user_id':UID}]:
            with self.assertRaises(ai.DraftError): ai.validate_description(value)
        self.assertEqual(ai.validate_description({'description':'  Provo to Moab on November 20, 2026.  '}),'Provo to Moab on November 20, 2026.')

    def test_invented_dates_times_and_places_are_left_blank(self):
        proposed = fields(origin_city='Orem',destination_name='Moab',departure_date='2026-11-20',departure_time='16:00')
        checked = ai.validate_draft(proposed,NOW,'Provo to Moab next weekend in the afternoon.')['fields']
        self.assertEqual(checked['destination_name'],'Moab')
        for key in ['origin_city','departure_date','departure_time']: self.assertIsNone(checked[key])
        checked = ai.validate_draft(proposed,NOW,'Orem to Moab on November 20, 2026 at 4 PM.')['fields']
        self.assertEqual(checked['departure_date'],'2026-11-20'); self.assertEqual(checked['departure_time'],'16:00')
        self.assertNotIn('09:30',ai.explicit_clock_times('9:30 PM'))
        self.assertIn('21:30',ai.explicit_clock_times('9:30 PM'))

    def test_identity_and_verification_are_checked_at_supabase(self):
        calls = []
        def request(url,headers,body=None,timeout=8):
            calls.append((url,body))
            return {'id':UID} if url.endswith('/user') else [{'user_id':UID,'is_verified':True}]
        with patch.object(ai,'json_request',side_effect=request):
            self.assertEqual(ai.verified_driver('test-token-with-enough-length',{'url':'https://database.test','publishableKey':'public'}),UID)
        self.assertEqual(calls[1][1],{'user_ids':[UID]})
        with patch.object(ai,'json_request',side_effect=[{'id':UID},[{'user_id':UID,'is_verified':False}]]):
            with self.assertRaises(ai.DraftError) as raised:
                ai.verified_driver('test-token-with-enough-length',{'url':'https://database.test'})
            self.assertEqual(raised.exception.status,403)

    def test_provider_uses_structured_output_no_storage_and_render_key_alias(self):
        response = {'status':'completed','output':[{'type':'message','content':[{'type':'output_text','text':json.dumps(fields(origin_city='Provo'))}]}]}
        settings = lambda name,default='': 'private-test-key' if name=='OpenAI_Key' else default
        with patch.object(ai,'setting',side_effect=settings), patch.object(ai,'json_request',return_value=response) as call:
            self.assertEqual(ai.generate_draft('Driving from Provo.')['fields']['origin_city'],'Provo')
        url,headers,body = call.call_args.args
        self.assertEqual(url,'https://api.openai.com/v1/responses')
        self.assertEqual(headers['Authorization'],'Bearer private-test-key')
        self.assertFalse(body['store'])
        self.assertTrue(body['text']['format']['strict'])
        self.assertNotIn('tools',body)

    def test_failures_never_leak_upstream_body_or_fake_success(self):
        with patch.object(ai,'setting',return_value='test-key'):
            for response in [{'status':'incomplete'}, {'status':'completed','output':[{'type':'message','content':[{'type':'refusal','refusal':'No'}]}]}]:
                with patch.object(ai,'json_request',return_value=response), self.assertRaises(ai.DraftError): ai.generate_draft('Driving to Moab.')
            error = HTTPError('https://api.openai.com',401,'provider private details',{},io.BytesIO(b'private-key'))
            with patch.object(ai,'json_request',side_effect=error), self.assertRaises(ai.DraftError) as raised: ai.generate_draft('Driving to Moab.')
            self.assertNotIn('private',str(raised.exception))
        with patch.object(ai,'setting',return_value=''), self.assertRaises(ai.DraftError) as raised: ai.generate_draft('Driving to Moab.')
        self.assertEqual(raised.exception.status,503)

    def test_limiter_prevents_duplicates_and_is_per_account(self):
        limiter = ai.DraftLimiter()
        with patch.object(ai.time,'monotonic',return_value=100):
            key = limiter.begin(UID)
            with self.assertRaises(ai.DraftError): limiter.begin(UID)
            limiter.end(key)
            for _ in range(4): limiter.end(limiter.begin(UID))
            with self.assertRaises(ai.DraftError): limiter.begin(UID)
            limiter.end(limiter.begin('another-account'))


class EndpointTest(unittest.TestCase):
    def test_origin_auth_body_validation_and_success(self):
        http = ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        threading.Thread(target=http.serve_forever,daemon=True).start()
        base = 'http://127.0.0.1:'+str(http.server_port)
        def post(value,**headers):
            return urlopen(Request(base+'/api/ai/trip-draft',data=json.dumps(value).encode(),headers={'Content-Type':'application/json','Origin':base,**headers},method='POST'))
        try:
            with patch.object(server,'verified_driver',return_value=UID) as auth, patch.object(server,'generate_draft',return_value={'fields':fields(origin_city='Provo'),'missing':[]}) as generate:
                for value,headers,code in [({'description':'Driving Provo to Moab.'},{'Origin':'https://outside.test'},403),({'description':'Driving Provo to Moab.'},{},401),({'description':'x'},{},400)]:
                    with self.assertRaises(HTTPError) as raised: post(value,**headers)
                    self.assertEqual(raised.exception.code,code)
                generate.assert_not_called(); auth.assert_not_called()
                with post({'description':'Driving Provo to Moab.'},Authorization='Bearer signed-in-test-token') as response:
                    self.assertEqual(response.headers['Cache-Control'],'no-store')
                    self.assertEqual(json.load(response)['fields']['origin_city'],'Provo')
                auth.assert_called_once(); generate.assert_called_once_with('Driving Provo to Moab.')
        finally:
            http.shutdown(); http.server_close()


if __name__ == '__main__': unittest.main()
