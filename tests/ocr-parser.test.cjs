const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/function ocrParseTimer\(text\) \{[\s\S]*?\n\}/);
assert.ok(source, 'OCR parser must exist');
const parse = vm.runInNewContext('(' + source[0] + ')');

test('complete timers retain minutes, including values above ten minutes', () => {
  assert.equal(parse('01:23.456'), 83.456);
  assert.equal(parse('12:34.567'), 754.567);
  assert.equal(parse('99:59.999'), 5999.999);
});

test('supported precision and harmless OCR spacing are preserved', () => {
  for (const [text, expected] of [
    ['1:23', 83], ['00:00.000', 0], ['01:23.4', 83.4],
    ['01:23.45', 83.45], [' \n01 ： 23.456\n', 83.456],
    ['23.456', 23.456], ['123.4', 123.4], ['3600.000', 3600],
  ]) assert.equal(parse(text), expected, text);
});

test('invalid or ambiguous output cannot fall back to a partial timer', () => {
  for (const text of [
    '', '   ', '01:60.123', '01:99.123', '01:2.345', '001:23.456',
    '01:23.4567', '23.4567', '0123456', '1234', '23',
    'TIME01:23.456', '01:23.456abc', '-23.456',
    '01:23.456\n02:34.567', '01:23:456', '23.', '.456',
    null, undefined, 83.456,
  ]) assert.equal(parse(text), null, String(text));
});
