// Checks the gateway's parsing against hand-built packets (run: node test-protocol.js)
'use strict';
const P = require('./protocol'), assert = require('assert');
const now = Date.UTC(2026, 9, 16, 10, 0, 0);
// one trend record: 1.21 mm/s X etc. at scale 816
const b = Buffer.alloc(P.HDR + P.REC); const ts = now / 1000 - 600;
b.writeUInt32LE(ts, 8); b.writeInt16LE(4520, 12);
b.writeUInt16LE(Math.round(1.21 / 25.4 * 816), 14); b.writeUInt16LE(Math.round(0.98 / 25.4 * 816), 16); b.writeUInt16LE(Math.round(0.65 / 25.4 * 816), 18);
b.writeUInt16LE(Math.round(0.12 * 816), 20);
const r = P.parseTrend(b, 816, now)[0];
assert.strictEqual(r.t, ts * 1000); assert.strictEqual(r.temp, 45.2);
assert.ok(Math.abs(r.vx - 1.21) < 0.02 && Math.abs(r.vz - 0.65) < 0.02 && Math.abs(r.ax - 0.12) < 0.002);
// invalid timestamps are skipped
const bad = Buffer.alloc(P.HDR + P.REC); assert.strictEqual(P.parseTrend(bad, 816, now).length, 0);
// system structure
const s = Buffer.alloc(220); s.writeUInt16LE(1 << 9 | 1 << 6, 4); s.writeUInt32LE(0, 68); s[118] = 9; s[119] = 16;
[0x30, 0x5A, 0x85, 0x4C, 0x07, 0xAC].forEach((x, i) => s[212 + i] = x); s.writeUInt16LE(3600, 206); s.writeUInt16LE(0xFFFF, 18);
const y = P.parseSys(s, 816, now);
assert.strictEqual(y.scale, 1289); assert.strictEqual(y.mac, '30:5A:85:4C:07:AC'); assert.strictEqual(y.clockOk, false);
assert.strictEqual(y.flags.running, true); assert.strictEqual(y.flags.battery, true); assert.strictEqual(y.thr.alarm[0], null); assert.strictEqual(y.battV, 3.6);
// request bytes
assert.deepStrictEqual([...P.requestBytes(1, 0x01020304)], [1, 0, 4, 3, 2, 1]);
// bulk collector: busy packet, header for 2 records, payload in 3 chunks
const c = new P.BulkCollector(1);
assert.strictEqual(c.push(Buffer.alloc(10)), false);
const h = Buffer.alloc(8); h.writeUInt16LE(2, 2); h.writeUInt32LE(56, 4);
assert.strictEqual(c.push(h), false); assert.strictEqual(c.push(Buffer.alloc(20)), false); assert.strictEqual(c.push(Buffer.alloc(20)), false);
assert.strictEqual(c.push(Buffer.alloc(16)), true); assert.strictEqual(c.buffer().length, 64);
// judge
const thr = { alarm: [4.5, 4.5, 4.5], warn: [2.8, 2.8, 2.8], ta: 85, tw: 70 };
assert.strictEqual(P.judge({ vx: 1, vy: 1, vz: 1, temp: 40 }, thr), 'ok');
assert.strictEqual(P.judge({ vx: 3, vy: 1, vz: 1, temp: 40 }, thr), 'warn');
assert.strictEqual(P.judge({ vx: 1, vy: 5, vz: 1, temp: 40 }, thr), 'alarm');
assert.strictEqual(P.judge({ vx: 1, vy: 1, vz: 1, temp: 72 }, thr), 'warn');
console.log('protocol tests passed');
