"""Build public/hitch-cities.json from the Census Bureau's 2025 Gazetteer.

Pass the downloaded national places and states ZIP files, in that order.
https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.2025.html
"""
import csv
import io
import json
import sys
from pathlib import Path
from zipfile import ZipFile

SUFFIXES = {
    '21': ' borough', '25': ' city', '37': ' municipality', '43': ' town',
    '47': ' village', '53': ' city and borough', '55': ' comunidad',
    '57': ' CDP', '62': ' zona urbana', 'CN': ' corporation',
}
COMMON_NAMES = {
    ('GA', 'Athens-Clarke County unified government (balance)'): 'Athens',
    ('GA', 'Augusta-Richmond County consolidated government (balance)'): 'Augusta',
    ('GA', 'Macon-Bibb County'): 'Macon',
    ('ID', 'Boise City city'): 'Boise',
    ('KY', 'Lexington-Fayette urban county'): 'Lexington',
    ('KY', 'Louisville/Jefferson County metro government (balance)'): 'Louisville',
    ('MT', 'Anaconda-Deer Lodge County'): 'Anaconda',
    ('MT', 'Butte-Silver Bow (balance)'): 'Butte',
    ('TN', 'Hartsville/Trousdale County'): 'Hartsville',
    ('TN', 'Lynchburg, Moore County metropolitan government'): 'Lynchburg',
    ('TN', 'Nashville-Davidson metropolitan government (balance)'): 'Nashville',
}


def records(path):
    with ZipFile(path) as archive:
        with archive.open(archive.namelist()[0]) as raw:
            yield from csv.DictReader(io.TextIOWrapper(raw, encoding='utf-8'), delimiter='|')


def city_name(row):
    name = row['NAME'].strip()
    common = COMMON_NAMES.get((row['USPS'], name))
    if common:
        return common
    if name.endswith(' city (balance)'):
        return name.removesuffix(' city (balance)')
    return name.removesuffix(SUFFIXES.get(row['LSAD'], ''))


if __name__ == '__main__':
    place_zip, state_zip = sys.argv[1:]
    states = {row['USPS']: row['NAME'].strip() for row in records(state_zip)}
    places = {code: set() for code in states}
    for row in records(place_zip):
        places[row['USPS']].add(city_name(row))
    output = Path(__file__).resolve().parents[1] / 'public/hitch-cities.json'
    with output.open('w', encoding='utf-8') as file:
        file.write('{\n"states":' + json.dumps(states, sort_keys=True) + ',\n"places":{\n')
        file.write(',\n'.join(f'{json.dumps(code)}:{json.dumps(sorted(names, key=str.casefold), ensure_ascii=False, separators=(",", ":"))}'
                              for code, names in sorted(places.items())))
        file.write('\n}\n}\n')
