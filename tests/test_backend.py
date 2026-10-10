import importlib.util
import json
import os
import sqlite3
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

spec=importlib.util.spec_from_file_location('backend',Path(__file__).resolve().parents[1]/'server.py')
backend=importlib.util.module_from_spec(spec); spec.loader.exec_module(backend)

class PersistenceTest(unittest.TestCase):
    def test_save_read_restart_and_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            backend.DB=Path(directory)/'test.sqlite3'; backend.initialize()
            server=ThreadingHTTPServer(('127.0.0.1',0),backend.Handler)
            threading.Thread(target=server.serve_forever,daemon=True).start()
            base=f'http://127.0.0.1:{server.server_port}'
            try:
                with backend.connect() as db:
                    for table in ['Users','Destinations','Trips','RideRequests','Messages']:
                        self.assertGreater(db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0],1)
                    self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(),[])
                payload=dict(hometown='Boise, ID',bio='Persistence test',color='#3B6EA8')
                def patch(value,origin=None):
                    headers={'Content-Type':'application/json'}
                    if origin: headers['Origin']=origin
                    return urlopen(Request(base+'/api/profile',data=json.dumps(value).encode(),headers=headers,method='PATCH'))
                with patch(payload) as response: self.assertEqual(json.load(response)['bio'],payload['bio'])
                with urlopen(base+'/api/profile') as response: self.assertEqual(json.load(response)['hometown'],'Boise, ID')
                backend.initialize() # The same startup routine must preserve saved data.
                with backend.connect() as db: self.assertEqual(backend.profile(db)['bio'],'Persistence test')
                for bad in [[],{**payload,'bio':'x'*161},{**payload,'color':'invalid'},{**payload,'first':'Other'}]:
                    with self.assertRaises(HTTPError) as error: patch(bad)
                    self.assertEqual(error.exception.code,400)
                with self.assertRaises(HTTPError) as error: patch(payload,'https://example.com')
                self.assertEqual(error.exception.code,403)
            finally: server.shutdown(); server.server_close()

if __name__=='__main__': unittest.main()
