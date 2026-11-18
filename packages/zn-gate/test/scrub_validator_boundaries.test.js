'use strict';

// Verdict boundaries of the scrub validators in lib/scrub/patterns.js that a mutation run
// showed no other test pins down: which IPv4 ranges count as public (and so are masked),
// which card numbers and phone numbers pass their checks, what looks like a random secret
// body and what is a placeholder. Inputs are made up: reserved or private address ranges,
// numbers built here with a check digit, and letters.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ipv4Public, cardValid, e164Valid, ibanValid, looksRandom, isPlaceholder,
} = require('../lib/scrub/patterns');

function luhnComplete(prefix, length) {
  const body = prefix.padEnd(length - 1, '0');
  let sum = 0;
  let dbl = true;
  for (let i = body.length - 1; i >= 0; i--) {
    let d = body.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return body + String((10 - (sum % 10)) % 10);
}

function ibanComplete(country, bban) {
  const digits = (bban + country + '00').replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  const check = 98n - (BigInt(digits) % 97n);
  return country + String(check).padStart(2, '0') + bban;
}

const publicIps = (list) => list.forEach((ip) => assert.equal(ipv4Public(ip), true, `${ip} is public`));
const nonPublicIps = (list) => list.forEach((ip) => assert.equal(ipv4Public(ip), false, `${ip} is not public`));

test('ipv4Public needs four dotted parts, each between 0 and 255', () => {
  nonPublicIps(['8.8.8', '8.8.8.8.8', '8.8.8.256', '256.8.8.8', '8.256.8.8', '8.8.-1.8', '8.8.x.8']);
  publicIps(['8.8.8.8', '8.8.8.255', '8.255.8.8', '8.8.255.8', '8.0.0.1']);
});

test('ipv4Public treats the zero, 10, loopback and multicast first octets as not public, and their neighbours as public', () => {
  nonPublicIps(['0.1.2.3', '10.1.2.3', '127.1.2.3', '224.1.2.3', '255.1.2.3']);
  publicIps(['1.1.2.3', '9.1.2.3', '11.1.2.3', '126.1.2.3', '128.1.2.3', '223.1.2.3']);
});

test('ipv4Public excludes link-local 169.254 only', () => {
  nonPublicIps(['169.254.0.1', '169.254.169.254']);
  publicIps(['169.253.0.1', '169.255.0.1', '168.254.0.1', '170.254.0.1', '8.254.1.1']);
});

test('ipv4Public excludes 172.16.0.0/12 exactly', () => {
  nonPublicIps(['172.16.0.1', '172.20.1.1', '172.31.255.254']);
  publicIps(['172.15.0.1', '172.32.0.1', '172.0.0.1', '171.16.0.1', '173.16.0.1', '8.16.0.1', '8.20.0.1']);
});

test('ipv4Public excludes 192.168.0.0/16 only', () => {
  nonPublicIps(['192.168.0.1', '192.168.255.254']);
  publicIps(['192.167.0.1', '192.169.0.1', '193.168.0.1', '8.168.0.1']);
});

test('ipv4Public excludes carrier-grade NAT 100.64.0.0/10 exactly', () => {
  nonPublicIps(['100.64.0.1', '100.100.1.1', '100.127.255.254']);
  publicIps(['100.63.255.254', '100.128.0.1', '100.0.0.1', '99.64.0.1', '101.64.0.1', '8.64.0.1', '8.100.0.1']);
});

test('ipv4Public excludes the documentation and special blocks and not the neighbouring addresses', () => {
  nonPublicIps(['192.0.0.1', '192.0.2.1']);
  publicIps(['192.1.2.1', '191.0.2.1', '193.0.2.1', '8.0.2.1']);
  nonPublicIps(['198.18.0.1', '198.19.0.1', '198.51.100.7']);
  publicIps(['198.17.0.1', '198.20.0.1', '198.50.100.7', '198.52.100.7', '197.18.0.1', '199.18.0.1', '8.18.0.1', '8.19.0.1', '8.51.0.1']);
  nonPublicIps(['203.0.113.5']);
  publicIps(['203.1.113.5', '202.0.113.5', '204.0.113.5', '8.0.113.5']);
});

test('cardValid accepts each network only at its allowed lengths', () => {
  const ok = (prefix, len) => assert.equal(cardValid(luhnComplete(prefix, len)), true, `${prefix} at ${len}`);
  const no = (prefix, len) => assert.equal(cardValid(luhnComplete(prefix, len)), false, `${prefix} at ${len}`);
  ok('6011', 16); ok('6011', 19); no('6011', 15); no('6011', 13);
  ok('3528', 16); ok('3589', 19); no('3528', 15); no('3589', 14);
  ok('3600', 14); ok('3800', 19); no('3600', 13); ok('3050', 14);
  ok('6200', 16); ok('6200', 19); no('6200', 15); no('6200', 14);
  ok('4000', 16); ok('4000', 13); no('4000', 14);
  ok('5100', 16); no('5100', 15);
  ok('3400', 15); no('3400', 16);
});

test('cardValid refuses a prefix that no network uses even with a good check digit', () => {
  assert.equal(cardValid(luhnComplete('9000', 16)), false);
  assert.equal(cardValid(luhnComplete('3527', 16)), false);
  assert.equal(cardValid(luhnComplete('3590', 16)), false);
  assert.equal(cardValid(luhnComplete('6300', 16)), false);
});

test('e164Valid rejects a leading zero and numbers shorter than ten digits with an unknown country code', () => {
  assert.equal(e164Valid('+04712345678'), false);
  assert.equal(e164Valid('+99912345'), false);
  assert.equal(e164Valid('+999123456'), false);
  assert.equal(e164Valid('+9991234567'), true);
});

test('looksRandom needs the character classes and the entropy, and accepts them exactly at the limit', () => {
  assert.equal(looksRandom('abcdefG1'), true, 'exactly 3 bits and three classes');
  assert.equal(looksRandom('abcdefgh12'), true, 'exactly two classes');
  assert.equal(looksRandom('abcdefghijklmnop'), false, 'one class');
  assert.equal(looksRandom('abcdefghIJKLMNOP'), true, 'letters of both cases');
  assert.equal(looksRandom('ABCDEFGHIJKLMNOP'), false, 'one class, upper case');
  assert.equal(looksRandom('1234567890123456'), false, 'one class, digits');
  assert.equal(looksRandom('abcdefG!'), true, 'a symbol is a class');
  assert.equal(looksRandom('aaaaaaaaB1'), false, 'low entropy');
});

test('isPlaceholder knows empty values, placeholder words and single repeated characters', () => {
  assert.equal(isPlaceholder(''), true);
  assert.equal(isPlaceholder(undefined), true);
  assert.equal(isPlaceholder('changeme'), true);
  assert.equal(isPlaceholder('your-key-here'), true);
  assert.equal(isPlaceholder('qZ7rT9LmW3'), false);
  assert.equal(isPlaceholder('kkkkkkkkkk'), true);
  assert.equal(isPlaceholder('kkkkkkkkkj'), false);
});

test('ibanValid reads the letters A and Z of the account part as 10 and 35', () => {
  assert.equal(ibanValid(ibanComplete('GB', 'AAAA60161331926819')), true);
  assert.equal(ibanValid(ibanComplete('GB', 'ZZZZ60161331926819')), true);
  assert.equal(ibanValid(ibanComplete('GB', 'AZAZ60161331926819')), true);
  const good = ibanComplete('GB', 'AAAA60161331926819');
  assert.equal(ibanValid(good.slice(0, 5) + 'B' + good.slice(6)), false);
  assert.equal(ibanValid('ZZ' + good.slice(2)), false, 'unknown country');
  assert.equal(ibanValid(good + '0'), false, 'wrong length');
});

test('luhnValid checks every digit and rejects anything that is not a digit', () => {
  const { luhnValid } = require('../lib/scrub/patterns');
  assert.equal(luhnValid('4242424242424242'), true);
  assert.equal(luhnValid('4242424242424241'), false);
  assert.equal(luhnValid('79927398713'), true);
  assert.equal(luhnValid('79927398710'), false);
  assert.equal(luhnValid('4242a24242424242'), false);
  assert.equal(luhnValid('4242:24242424242'), false);
  assert.equal(luhnValid('/242424242424242'), false);
});

test('dniValid and nieValid need the exact shape and the right control letter', () => {
  const { dniValid, nieValid } = require('../lib/scrub/patterns');
  assert.equal(dniValid('12345678Z'), true);
  assert.equal(dniValid('12345678-Z'), true);
  assert.equal(dniValid('12345678T'), false);
  assert.equal(dniValid('A12345678Z'), false);
  assert.equal(dniValid('12345678Zx'), false);
  assert.equal(dniValid('1234567Z'), false);
  assert.equal(nieValid('X1234567L'), true);
  assert.equal(nieValid('X1234567T'), false);
  assert.equal(nieValid('AX1234567L'), false);
  assert.equal(nieValid('X1234567LA'), false);
  assert.equal(nieValid('X123456L'), false);
});

test('ssnValid needs the dashed shape and refuses the reserved area, group and serial numbers', () => {
  const { ssnValid } = require('../lib/scrub/patterns');
  assert.equal(ssnValid('123-45-6789'), true);
  assert.equal(ssnValid('899-45-6789'), true);
  assert.equal(ssnValid('001-01-0001'), true);
  for (const bad of ['000-45-6789', '666-45-6789', '900-45-6789', '123-00-6789', '123-45-0000', 'a123-45-6789', '123-45-6789b', '123456789']) {
    assert.equal(ssnValid(bad), false, bad);
  }
});

test('ibanValid needs the two letters, two check digits and an alphanumeric rest in the right shape', () => {
  const good = ibanComplete('GB', 'AAAA60161331926819');
  assert.equal(ibanValid(good), true);
  assert.equal(ibanValid(good.toLowerCase()), true);
  assert.equal(ibanValid(good.slice(0, 4) + ' ' + good.slice(4, 8) + '-' + good.slice(8)), true);
  assert.equal(ibanValid(good.slice(0, 2) + 'A' + good.slice(3)), false);
  assert.equal(ibanValid(good.slice(0, 5) + '*' + good.slice(6)), false);
});
