const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

test('hometown search distinguishes same-name cities and returns consistent city/state labels', async () => {
  const {indexCities, matchCities} = await import(pathToFileURL(path.resolve('public/hitch-cities.js')));
  const cities = indexCities(JSON.parse(fs.readFileSync('public/hitch-cities.json', 'utf8')));
  assert.ok(matchCities(cities, 'Portland').includes('Portland, ME'));
  assert.ok(matchCities(cities, 'Portland').includes('Portland, OR'));
  assert.equal(matchCities(cities, 'portland, oregon')[0], 'Portland, OR');
  assert.equal(matchCities(cities, 'boise id')[0], 'Boise, ID');
  assert.equal(matchCities(cities, 'st george, ut')[0], 'St. George, UT');
  assert.deepEqual(matchCities(cities, 'xxxxville, UT'), []);
});
