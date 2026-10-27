"""Local classroom backend: Python standard library + persistent SQLite."""
import json
import os
import sqlite3
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get('HITCH_DB', str(ROOT / 'data/hitch.sqlite3')))
COLORS = {'#2F6B5E','#3B6EA8','#B0562F','#7B4FA0','#A8456B','#4F6B2E'}

def connect():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db

def initialize():
    DB.parent.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript((ROOT / 'database/schema.sql').read_text())
        if db.execute('SELECT COUNT(*) FROM Users').fetchone()[0]:
            return  # Never reseed over changes on restart.
        seed = json.loads((ROOT / 'database/seed.json').read_text())
        users = {'me':dict(first='Jordan',last='Hale',hometown='Spokane, WA',bio='Sophomore in Information Systems. Happy to split gas and make a good playlist.',color='#2F6B5E',verified='verified'), **seed['users']}
        for uid,u in users.items():
            db.execute('INSERT INTO Users VALUES (?,?,?,?,?,?,?,?,?)', (uid,'jhale' if uid=='me' else uid,u['first'],u['last'],u['hometown'],u['bio'],None,u['color'],1))
        for d in seed['destinations']:
            db.execute('INSERT INTO Destinations VALUES (?,?,?,?)',(d['id'],d['name'],'WY' if d['id']=='jackson' else 'UT',d['cat']))
        for t in seed['trips']:
            db.execute('INSERT INTO Trips VALUES (?,?,?,?,?,?,?,?,?,?,?)',(t['id'],t['driver'],t['dest'],t['depart'],t['pickup'],t['dropoff'],t['vehicle'],t['seats'],t['price'],int(bool(t['ret'])),t['ret']))
            for uid in t['passengers']:
                db.execute('INSERT INTO RideRequests(TripID,RiderID,RequestStatus) VALUES (?, ?, ?)',(t['id'],uid,'accepted'))
            for r in t['requests']:
                db.execute('INSERT INTO RideRequests(TripID,RiderID,RequestStatus,RequestMessage) VALUES (?,?,?,?)',(t['id'],r['uid'],r['status'],r['note']))
        for tid,msgs in seed['chats'].items():
            for m in msgs:
                db.execute('INSERT INTO Messages(TripID,SenderID,MessageText,SentAt) VALUES (?,?,?,?)',(tid,m['uid'],m['text'],m['at']))

def profile(db):
    u = db.execute("SELECT * FROM Users WHERE UserID='me'").fetchone()
    return dict(first=u['FirstName'],last=u['LastName'],hometown=u['Hometown'],bio=u['Bio'],color=u['AvatarColor'],photo=u['ProfilePhotoURL'],verified='verified' if u['IsVerified'] else 'pending',username=u['Username'])

class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, value):
        body=json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json')
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Length',str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def do_GET(self):
        if self.path == '/api/profile':
            with connect() as db: self.send_json(200,profile(db))
        elif self.path in ('/','/index.html'):
            body=(ROOT/'public/index.html').read_bytes()
            self.send_response(200); self.send_header('Content-Type','text/html; charset=utf-8')
            self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
        elif self.path in ('/supabase-config.json', '/hitch-supabase.js'):
            body=(ROOT/'public'/self.path.lstrip('/')).read_bytes()
            content_type='application/json' if self.path.endswith('.json') else 'text/javascript'
            self.send_response(200); self.send_header('Content-Type',content_type)
            self.send_header('Cache-Control','no-store')
            self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
        else: self.send_json(404,{'error':'Not found'})

    def do_PATCH(self):
        if self.path != '/api/profile': return self.send_json(404,{'error':'Not found'})
        # Reject cross-origin mutations; bind to loopback for the fixed demo identity.
        origin=self.headers.get('Origin')
        if origin and origin != 'http://' + self.headers.get('Host',''):
            return self.send_json(403,{'error':'Cross-origin request rejected'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0 < length <= 4096: raise ValueError('Invalid request size')
            value=json.loads(self.rfile.read(length))
            if not isinstance(value,dict): raise ValueError('Expected an object')
            if set(value) != {'hometown','bio','color'}: raise ValueError('Expected hometown, bio, and color')
            if not all(isinstance(v,str) for v in value.values()): raise ValueError('Fields must be text')
            home,bio,color=value['hometown'].strip(),value['bio'].strip(),value['color']
            if len(home)>100 or len(bio)>160 or color not in COLORS: raise ValueError('Invalid hometown, bio, or avatar color')
        except (ValueError, json.JSONDecodeError):
            return self.send_json(400,{'error':'Use a hometown up to 100 characters, bio up to 160 characters, and a listed avatar color.'})
        try:
            with connect() as db:
                db.execute("UPDATE Users SET Hometown=?,Bio=?,AvatarColor=? WHERE UserID='me'",(home,bio,color))
                updated=profile(db)
            self.send_json(200,updated) # Transaction committed before reporting success.
        except sqlite3.Error:
            self.send_json(500,{'error':'Database save failed. Please retry.'})

if __name__ == '__main__':
    initialize()
    port=int(os.environ.get('PORT','8000'))
    print(f'Hitch classroom demo: http://127.0.0.1:{port}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',port),Handler).serve_forever()
