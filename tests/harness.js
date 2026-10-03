let pass = 0, fail = 0; const failures = [];
function test(name, fn) {
  try { const r = fn(); if (r && r.then) return r.then(() => { pass++; console.log('  ok   ' + name); }, (e) => { fail++; failures.push(name); console.log('  FAIL ' + name + '\n       ' + e.message); }); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; failures.push(name); console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function near(a, b, tol, msg) { if (!(Math.abs(a - b) <= tol)) throw new Error((msg || 'near') + ': expected ' + b + ' got ' + a + ' (tol ' + tol + ')'); }
function ok(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }
function summary() { console.log(`\n${pass} passed, ${fail} failed`); if (fail) { console.log('Failed: ' + failures.join('; ')); process.exitCode = 1; } return { pass, fail }; }
module.exports = { test, near, ok, summary };
