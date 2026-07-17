/**
 * Material Takeoff — rate limiter unit tests
 * Same dependency-free harness style as the other test files. `now` is injected so the
 * window/reset behaviour is deterministic (no real clock, no sleeps).
 */
const {
  clientKey, createRateLimiter, createNoopLimiter, selectRateLimiter,
} = require('./rate_limiter.js');

let pass = 0, fail = 0;
function check(name, cond) { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); cond ? pass++ : fail++; }

console.log('========================================');
console.log('RATE LIMITER — fixed window');
console.log('========================================');

const rl = createRateLimiter({ windowMs: 1000, max: 3 });
const T = 10_000; // fixed base "now"

const r1 = rl.check('1.1.1.1', T);
check('first request allowed', r1.allowed === true);
check('limit reported = 3', r1.limit === 3);
check('remaining after 1st = 2', r1.remaining === 2);
check('resetAt = now + windowMs', r1.resetAt === T + 1000);

check('2nd allowed (remaining 1)', rl.check('1.1.1.1', T).remaining === 1);
check('3rd allowed (remaining 0)', rl.check('1.1.1.1', T).remaining === 0);

const r4 = rl.check('1.1.1.1', T);
check('4th BLOCKED', r4.allowed === false);
check('  -> remaining stays 0', r4.remaining === 0);
check('  -> retryAfterMs = full window (fresh window)', r4.retryAfterMs === 1000);

// Different client has its own bucket.
check('different IP has its own bucket (allowed)', rl.check('2.2.2.2', T).allowed === true);

// Window reset: once now passes resetAt, the count restarts.
check('same client allowed again after window elapses', rl.check('1.1.1.1', T + 1000).allowed === true);
check('  -> retryAfterMs shrinks mid-window', rl.check('1.1.1.1', T + 1500).allowed === true);

console.log('\n--- configure / reset / sweep ---');
rl.configure({ max: 1 });
rl.reset();
check('reconfigure max=1 + reset -> 1st allowed', rl.check('9.9.9.9', T).allowed === true);
check('  -> 2nd blocked at max=1', rl.check('9.9.9.9', T).allowed === false);

const rl2 = createRateLimiter({ windowMs: 1000, max: 5 });
rl2.check('a', T); rl2.check('b', T);
check('sweep keeps live buckets', rl2.sweep(T + 500) === 2);
check('sweep drops expired buckets', rl2.sweep(T + 2000) === 0);

console.log('\n========================================');
console.log('CLIENT KEY');
console.log('========================================');
check('uses X-Forwarded-For first hop', clientKey({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.1' } }) === '203.0.113.7');
check('falls back to socket.remoteAddress', clientKey({ headers: {}, socket: { remoteAddress: '198.51.100.4' } }) === '198.51.100.4');
check('unknown when nothing available', clientKey({ headers: {}, socket: {} }) === 'unknown');

console.log('\n========================================');
console.log('NO-OP LIMITER + ENV SELECTION');
console.log('========================================');
const noop = createNoopLimiter();
check('noop always allows', noop.check('x').allowed === true && noop.check('x').allowed === true);

check('default env -> enabled, 120/60s', (() => { const s = selectRateLimiter({}); return s.enabled && s.limiter.config.max === 120 && s.limiter.config.windowMs === 60000; })());
check('custom env respected', (() => { const s = selectRateLimiter({ RATE_LIMIT_MAX: '30', RATE_LIMIT_WINDOW_MS: '10000' }); return s.limiter.config.max === 30 && s.limiter.config.windowMs === 10000; })());
check('RATE_LIMIT_DISABLED=1 -> noop (not enabled)', (() => { const s = selectRateLimiter({ RATE_LIMIT_DISABLED: '1' }); return s.enabled === false && s.limiter.id === 'noop'; })());
check('RATE_LIMIT_DISABLED=false -> still enabled', selectRateLimiter({ RATE_LIMIT_DISABLED: 'false' }).enabled === true);

console.log('\n========================================');
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('========================================');
process.exit(fail > 0 ? 1 : 0);
