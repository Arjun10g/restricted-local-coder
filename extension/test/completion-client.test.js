'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { deltaText } = require('../src/client');

test('OpenAI-compatible streamed content is extracted without executing markup', () => {
  assert.equal(deltaText({ content: 'const x = 1;' }), 'const x = 1;');
  assert.equal(deltaText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'ab');
  assert.equal(deltaText({ reasoning_content: 'hidden' }), '');
});
