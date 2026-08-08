import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { rawQueryValue } from './router.mjs';

test('rawQueryValue keeps a literal "+" (no form-style +→space conversion)', () => {
  assert.equal(rawQueryValue('?k=abc+def', 'k'), 'abc+def'); // "+" preserved (URLSearchParams would give "abc def")
  assert.equal(rawQueryValue('?k=901affeedead', 'k'), '901affeedead'); // hex secret, unchanged
  assert.equal(rawQueryValue('?x=1&k=se/cr+et=', 'k'), 'se/cr+et='); // base64 chars survive, param picked among others
});

test('rawQueryValue percent-decodes so an encoded secret matches its literal form', () => {
  assert.equal(rawQueryValue('?k=abc%2Bdef', 'k'), 'abc+def'); // %2B → + (the regression this fixes)
  assert.equal(rawQueryValue('?k=a%26b', 'k'), 'a&b'); // an encoded delimiter round-trips
  assert.equal(rawQueryValue('?k=abc%', 'k'), 'abc%'); // malformed escape: no throw, compares raw
});

test('rawQueryValue handles empty and missing params', () => {
  assert.equal(rawQueryValue('?k=', 'k'), ''); // present but empty
  assert.equal(rawQueryValue('?x=1', 'k'), null); // missing
  assert.equal(rawQueryValue('', 'k'), null); // no query string
});
