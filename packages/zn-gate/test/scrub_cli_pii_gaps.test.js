'use strict';

// Personal values the scrubber missed (B-8513): a US phone with the area code in parentheses, an American Express number
// written 4-6-5 with spaces, a full_name key, a CJK name label, and a street address without an address= key.
// Each form comes with the near misses that must stay readable. The phone and card forms are shared with the Python
// package (test/fixtures/pii_parity_cases.json); the name and address forms are Node.js only for now.

const test = require('node:test');
const assert = require('node:assert/strict');
const { findPii } = require('../lib/scrub/patterns');

function hits(text, type) {
  return findPii(text).filter((h) => h.type === type).map((h) => text.slice(h.start, h.end));
}

test('US phone with the area code in parentheses', () => {
  assert.deepEqual(hits('phone: (415) 555-0132', 'PHONE'), ['(415) 555-0132']);
  assert.deepEqual(hits('call (415)555-0132 or (415) 555 0132 or (415) 555.0132', 'PHONE'), ['(415)555-0132', '(415) 555 0132', '(415) 555.0132']);
  assert.deepEqual(hits('tel +1 (415) 555-0132 now', 'PHONE'), ['+1 (415) 555-0132']);
  assert.deepEqual(hits('(415) 555-0132, (212) 555-0199', 'PHONE'), ['(415) 555-0132', '(212) 555-0199']);
});

test('parentheses that are not a phone number stay', () => {
  for (const text of ['f(415) 555-0132', '(015) 555-0132', '(415) 055-0132', '(222) 222-2222', 'see (1999) 2000-2005',
    '(415) 555-01321', '(415) 555-013', 'x(1) 555-0132']) {
    assert.deepEqual(hits(text, 'PHONE'), [], text);
  }
});

test('American Express with spaces, 4-6-5, needs a valid Luhn digit', () => {
  assert.deepEqual(hits('amex 3782 822463 10005', 'CARD'), ['3782 822463 10005']);
  assert.deepEqual(hits('amex 3714 496353 98431.', 'CARD'), ['3714 496353 98431']);
  for (const text of ['3782 822463 10006', '3182 822463 10005', '3782 822463 100055', '3782  822463 10005', '3782 822463-10005']) {
    assert.deepEqual(hits(text, 'CARD'), [], text);
  }
});

test('full_name as a text label or a JSON key', () => {
  assert.deepEqual(hits('full_name: "Juan Perez Falso"', 'PERSON_NAME'), ['Juan Perez Falso']);
  assert.deepEqual(hits('{"full_name": "Ana Imaginaria Lopez", "id": 7}', 'PERSON_NAME'), ['Ana Imaginaria Lopez']);
  assert.deepEqual(hits('Full name: Maria Ejemplo Ficticia', 'PERSON_NAME'), ['Maria Ejemplo Ficticia']);
  assert.deepEqual(hits('fullName: "Luis Inventado"', 'PERSON_NAME'), ['Luis Inventado']);
});

test('full_name in code, schemas and prose is not a person', () => {
  for (const text of ['full_name: str', 'full_name: string', '{"full_name": "string"}', 'full_name: the user full name',
    'full_name: Maria', 'full_name: null', 'full_name: {{ user.name }}', 'def f(full_name: str): ...', 'user_full_name: Maria Ejemplo']) {
    assert.deepEqual(hits(text, 'PERSON_NAME'), [], text);
  }
});

test('a name under the CJK labels 姓名 and 氏名', () => {
  assert.deepEqual(hits('姓名：山田太郎 電話', 'PERSON_NAME'), ['山田太郎']);
  assert.deepEqual(hits('姓名: 王小明, 年龄 30', 'PERSON_NAME'), ['王小明']);
  assert.deepEqual(hits('氏名:"佐藤花子"', 'PERSON_NAME'), ['佐藤花子']);
  assert.deepEqual(hits('성명: 김민준 연락처', 'PERSON_NAME'), ['김민준']);
  for (const text of ['姓名：必填', '姓名：', '姓名：A', '姓名 山田太郎', '姓名：山田太郎山田太郎山田太郎山田太郎']) {
    assert.deepEqual(hits(text, 'PERSON_NAME'), [], text);
  }
});

test('a street address under a street key, or after ship to', () => {
  assert.deepEqual(hits('"street": "45 Invented Avenue", "zip": "00000"', 'POSTAL_ADDRESS'), ['45 Invented Avenue']);
  assert.deepEqual(hits('street: 12 Imaginary Road\ncity: Nowhere', 'POSTAL_ADDRESS'), ['12 Imaginary Road']);
  assert.deepEqual(hits('{"street_address":"9 Fake Lane, Faketown"}', 'POSTAL_ADDRESS'), ['9 Fake Lane, Faketown']);
  assert.deepEqual(hits('ship to: 742 Evergreen Terrace, Springfield', 'POSTAL_ADDRESS'), ['742 Evergreen Terrace, Springfield']);
  assert.deepEqual(hits('please ship to 742 Evergreen Terrace, Springfield 99999\nthanks', 'POSTAL_ADDRESS'), ['742 Evergreen Terrace, Springfield 99999']);
  assert.deepEqual(hits('Shipping to 10 Downing Street London', 'POSTAL_ADDRESS'), ['10 Downing Street London']);
  assert.deepEqual(hits('ship to Calle Mayor 12, Madrid', 'POSTAL_ADDRESS'), ['Calle Mayor 12, Madrid']);
});

test('street keys and ship to in code and prose are not an address', () => {
  for (const text of ['"street": "Main"', '"street": "string"', 'street: ', 'we ship to 3 customers in the EU', 'ship to the warehouse',
    'ship to 200 stores by Court order', 'ship to 5 regions via Plaza partners', 'ship to: 12', 'street_view: 12 images per tile']) {
    assert.deepEqual(hits(text, 'POSTAL_ADDRESS'), [], text);
  }
});

test('the new keyed forms stay linear', () => {
  const inputs = [
    'ship to ' + ' '.repeat(200000),
    'ship to 1 ' + 'a '.repeat(100000),
    'full_name' + ' '.repeat(200000),
    '"full_name"' + ' '.repeat(100000) + ':',
    '姓名：' + '山'.repeat(200000),
    '姓名'.repeat(100000),
    'street: ' + '1 '.repeat(100000),
    'ship to 1 Main Street '.repeat(10000),
  ];
  for (const text of inputs) {
    const t0 = process.hrtime.bigint();
    findPii(text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1500, `${ms} ms on a ${text.length}-character input`);
  }
});
