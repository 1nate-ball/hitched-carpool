"""Read-only check of the configured class project's API and signed-out access."""
import json
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
config = json.loads((ROOT / 'public/supabase-config.json').read_text())
for table in ('destinations', 'trips'):
    request = Request(config['url'] + '/rest/v1/' + table + '?select=*&limit=1',
                      headers={'apikey': config['publishableKey']})
    try:
        with urlopen(request, timeout=20) as response:
            raise RuntimeError(f'{table}: unexpected signed-out access ({response.status})')
    except HTTPError as error:
        result = json.load(error)
        if error.code not in (401, 403) or result.get('code') != '42501':
            raise RuntimeError(f'{table}: unexpected API result {error.code}, {result.get("code")}')
        print(f'{table}: API reachable; signed-out access denied as intended')
print('PASS: project URL and publishable key reach the Data API. Authenticated form testing remains.')
