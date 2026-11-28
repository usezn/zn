'use strict';

// Keyed names and addresses (title false positives, Han names), percent-encoded phone values and Chinese
// bank cards. Every value is invented. The Python side is packages/zn-gate-py/tests/test_pii_phone_percent.py.

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../lib/scrub/engine');

function kinds(text, type) {
  return engine.scan(text, { exact: false })
    .filter((s) => s.type === type).map((s) => text.slice(s.start, s.end));
}
const q = (key, value) => `?${key}=${encodeURIComponent(value)}`;

/* ---- person names: product and place titles ---- */

test('product and place titles under name= and full_name= are not person names', () => {
  const titles = ['Wireless Headphones Pro', 'The Great Escape', 'Oxford Street', 'Acme Widgets Inc', 'Starter Kit Plus',
    'Los Angeles', 'Calle Mayor', 'Hotel Playa Azul', 'Rue de Rivoli', 'Les Miserables', 'Rua Augusta', 'Avenida da Liberdade',
    'New York', 'Summer Sale Collection', 'Deluxe Edition Bundle', 'Museo Nacional', 'Quick Start Manual', 'Praça do Comércio'];
  for (const key of ['name', 'full_name']) {
    for (const t of titles) assert.deepEqual(kinds(q(key, t), 'PERSON_NAME'), [], `${key}=${t}`);
  }
  assert.deepEqual(kinds('X-User-Name: The Great Escape', 'PERSON_NAME'), []);
  assert.deepEqual(kinds('name=Lord of the rings', 'PERSON_NAME'), []);
});

test('real names under name= and full_name= are still found, surnames that look like words included', () => {
  const names = ['Marisol Quintanilla', 'Patrick O\'Brien', 'Mary-Jane Watson', 'Susan Park', 'Tom Lane', 'Max Bridge', 'Carlos Plaza',
    'María José García López', 'Maria dos Santos', 'João das Neves', 'Jean-Pierre Marchand', 'Daniel Newman', 'Fatima Al-Sayed',
    'Joaquín de la Torre'];
  for (const key of ['name', 'full_name']) {
    for (const n of names) assert.equal(kinds(q(key, n), 'PERSON_NAME').length, 1, `${key}=${n}`);
  }
  assert.equal(kinds('X-User-Name: Susan Park', 'PERSON_NAME').length, 1);
});

/* ---- Han names ---- */

test('Han person names are found under name= and full_name=', () => {
  for (const n of ['王小明', '李伟', '张海燕', '欧阳娜娜', '诸葛亮', '周杰']) {
    for (const key of ['name', 'full_name']) assert.equal(kinds(q(key, n), 'PERSON_NAME').length, 1, `${key}=${n}`);
  }
  assert.equal(kinds('X-User-Name: 王小明', 'PERSON_NAME').length, 1);
  assert.equal(kinds('name=王小明&x=1', 'PERSON_NAME').length, 1);
});

test('Han place, product and organisation words are not names; one character or five is not a name', () => {
  for (const v of ['北京', '上海市', '苹果手机', '朝阳区', '建国路', '无线耳机', '人民医院', '李', '王小明小明']) {
    for (const key of ['name', 'full_name']) assert.deepEqual(kinds(q(key, v), 'PERSON_NAME'), [], `${key}=${v}`);
  }
  // bare, without a key, nothing is found
  assert.deepEqual(kinds('王小明', 'PERSON_NAME'), []);
});

/* ---- postal addresses ---- */

test('short values with a digit and letters are not postal addresses', () => {
  for (const v of ['A1 B2', 'v2 ok', 'Version 2 ok', 'Windows 11 Pro', 'Room 12', 'Step 3 of 5', 'Order 1234 ok', 'Route 66', 'Q4 2026 plan', 'iPhone 15 case']) {
    assert.deepEqual(kinds(q('address', v), 'POSTAL_ADDRESS'), [], v);
  }
});

test('postal addresses of several shapes are still found', () => {
  for (const v of ['Calle Mayor 12, 28013 Madrid', '12 Baker Street, London NW1 6XE', '221B Baker Street London', '45 Rue de la Paix, 75002 Paris',
    'Rua Augusta 100, 1100-053 Lisboa', 'Hauptstraße 5, 10115 Berlin', 'Via Roma 10, 00184 Roma', '12 Baker Row London', '78 Oak Lane',
    'Avenida Paulista 1000, São Paulo', '1 Example Street', '北京市朝阳区建国路88号', '上海市浦东新区世纪大道100号']) {
    assert.equal(kinds(q('address', v), 'POSTAL_ADDRESS').length, 1, v);
  }
  assert.equal(kinds('X-Address: 1 Example Street, Springfield', 'POSTAL_ADDRESS').length, 1);
});

/* ---- phone with a percent-encoded plus sign ---- */

test('a percent-encoded plus sign with %20 spaces is a phone number', () => {
  assert.deepEqual(kinds('phone=%2B34%20600%20123%20456', 'PHONE'), ['%2B34%20600%20123%20456']);
  assert.deepEqual(kinds('?tel=%2b34%20600%20123%20456&x=1', 'PHONE'), ['%2b34%20600%20123%20456']);
  assert.deepEqual(kinds('phone=+34%20600%20123%20456', 'PHONE'), ['+34%20600%20123%20456']);
  assert.deepEqual(kinds('phone=%2B34%20600123456', 'PHONE'), ['%2B34%20600123456']);
  assert.deepEqual(kinds('phone=%2B34600123456', 'PHONE'), ['%2B34600123456']);
});

test('%20 between short digit runs is not a phone number', () => {
  for (const t of ['x=%2B34%20600', 'sum=%2B1%202', 'v=%2B0%20600%20123%20456', 'a=%2B1%202%203', '100%2B3400000000']) {
    assert.deepEqual(kinds(t, 'PHONE'), [], t);
  }
});

/* ---- Chinese bank cards ---- */

test('Chinese 19-digit bank cards with a Luhn check digit are cards', () => {
  for (const v of ['6222020123456789015', '6222 0201 2345 6789 015', '8100000123456789015', '8100 0001 2345 6789 015', '8100-0001-2345-6789-015']) {
    assert.equal(kinds(`card ${v} end`, 'CARD').length, 1, v);
  }
});

test('long numbers that are not Chinese bank cards are left alone', () => {
  for (const v of ['8100000123456789016', '9560800123456789019', '1700000000000000000', '1700000000123456789', '8100000123456789015a', '18100000123456789015']) {
    assert.deepEqual(kinds(`id ${v} end`, 'CARD'), [], v);
  }
});
