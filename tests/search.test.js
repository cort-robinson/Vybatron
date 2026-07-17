import test from 'node:test';
import assert from 'node:assert/strict';
import { searchFailureMessage } from '../src/utils/search.js';

test('search failures distinguish no matches from source errors', () => {
  assert.match(searchFailureMessage({ loadType: 'empty' }, 'track name'), /No matches/);
  assert.match(searchFailureMessage({ loadType: 'error' }, 'track name'), /Couldn’t load/);
  assert.match(searchFailureMessage({ loadType: 'error' }, '@everyone **bad**'), /@​everyone/);
});
