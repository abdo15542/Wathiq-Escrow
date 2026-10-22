const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { signToken, verifyToken } = require('../src/app');

const secret = 'test-secret-that-is-long-enough-for-unit-tests';
const now = 1_800_000_000;

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signedWithHeader(header, payload) {
  const unsigned = encode(header) + '.' + encode(payload);
  const signature = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
  return unsigned + '.' + signature;
}

test('accepts an unmodified HS256 token before expiration', () => {
  const token = signToken({ sub: 12, role: 'user', exp: now + 60 }, secret);
  assert.deepEqual(verifyToken(token, secret, now), {
    sub: 12,
    role: 'user',
    exp: now + 60,
  });
});

test('rejects expired tokens and malformed or incomplete claims', () => {
  assert.equal(verifyToken(signToken({ sub: 12, exp: now }, secret), secret, now), null);
  assert.equal(verifyToken(signToken({ sub: 0, exp: now + 60 }, secret), secret, now), null);
  assert.equal(verifyToken(signToken({ sub: 12.5, exp: now + 60 }, secret), secret, now), null);
  assert.equal(verifyToken(signToken({ sub: 12, exp: 'later' }, secret), secret, now), null);
});

test('rejects changed signatures and tokens signed with a different secret', () => {
  const token = signToken({ sub: 12, exp: now + 60 }, secret);
  const parts = token.split('.');
  parts[1] = encode({ sub: 99, exp: now + 60 });
  assert.equal(verifyToken(parts.join('.'), secret, now), null);
  assert.equal(verifyToken(token, 'a-different-long-enough-secret', now), null);
});

test('rejects unexpected JWT algorithms and token types even with a valid signature', () => {
  const payload = { sub: 12, exp: now + 60 };
  assert.equal(
    verifyToken(signedWithHeader({ alg: 'none', typ: 'JWT' }, payload), secret, now),
    null,
  );
  assert.equal(
    verifyToken(signedWithHeader({ alg: 'HS256', typ: 'JWE' }, payload), secret, now),
    null,
  );
});

test('rejects non-canonical segments, excessive token sizes and absent tokens', () => {
  const valid = signToken({ sub: 12, exp: now + 60 }, secret);
  assert.equal(verifyToken(null, secret, now), null);
  assert.equal(verifyToken('', secret, now), null);
  assert.equal(verifyToken('a.b.c!invalid', secret, now), null);
  assert.equal(verifyToken(valid + 'x'.repeat(8192), secret, now), null);
});
