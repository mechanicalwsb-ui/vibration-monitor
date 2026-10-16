// i-ALERT3 protocol helpers shared by the gateway (same rules as the web dashboard).
// Read-only towards the sensor: the only bytes ever written are bulk *download requests*
// ([opcode, 0, from u32 LE] on the bulk characteristic), exactly like the dashboard and the app.
'use strict';

const UUID = {
  svc: 'fea3',                                   // 0000fea3-0000-1000-8000-00805f9b34fb (noble short form)
  bulk: '8c3bff38b85340b585d286dda1e2cb28',
  sys: '8c3bff37e79640b585d286dda1e2cb28',
};
const REC = 28, HDR = 8;

// Trend payload: 8-byte header + 28-byte records (little-endian)
function parseTrend(buf, scale, nowMs = Date.now()) {
  const out = [], maxTs = nowMs / 1000 + 86400, minTs = 1420070400;
  for (let o = HDR; o + REC <= buf.length; o += REC) {
    let ts = buf.readUInt32LE(o);
    if (ts === 0 || ts === 0xFFFFFFFF) continue;
    if (ts > maxTs) ts &= 0x7FFFFFFF;             // old firmware keeps a flag in bit 31
    if (ts > maxTs || ts < minTs) continue;
    const u = k => buf.readUInt16LE(o + k), r4 = v => Math.round(v * 1e4) / 1e4;
    out.push({ t: ts * 1000, temp: buf.readInt16LE(o + 4) / 100,
      vx: r4(u(6) / scale * 25.4), vy: r4(u(8) / scale * 25.4), vz: r4(u(10) / scale * 25.4),
      ax: r4(u(12) / scale), ay: r4(u(14) / scale), az: r4(u(16) / scale) });
  }
  return out;
}

// System structure (220 bytes). Offsets from the app's ITTiAlert3SystemStructure.
function parseSys(b, fallbackScale = 816, nowMs = Date.now()) {
  if (b.length < 212) return null;
  const u32 = o => b.readUInt32LE(o), u16 = o => b.readUInt16LE(o), u8 = o => b.readUInt8(o);
  const devType = u8(118), scale = devType === 9 ? 1289 : devType === 8 ? 816 : fallbackScale;
  const r4 = v => Math.round(v * 1e4) / 1e4;
  const vth = o => { const v = u16(o); return v >= 0xFFFF ? null : r4(v / scale * 25.4); };
  const tth = o => { const v = b.readInt16LE(o); return v >= 0x7FFF ? null : v / 100; };
  const st = u16(4), bit = n => !!((st >> n) & 1);
  const recBuf = Buffer.alloc(HDR + REC); b.copy(recBuf, HDR, 144, 144 + REC);
  const mac = b.length >= 218 ? [...b.subarray(212, 218)].map(x => x.toString(16).padStart(2, '0').toUpperCase()).join(':') : null;
  const rpm = u16(172), clock = u32(68);
  return {
    clock, clockOk: Math.abs(clock - nowMs / 1000) <= 86400, lastTrend: u32(144), devType, rev: u8(119), scale, mac,
    thr: { alarm: [18, 20, 22].map(vth), warn: [24, 26, 28].map(vth), ta: tth(14), tw: tth(16) },
    flags: { battery: bit(6), running: bit(9), tempAlarm: bit(10), tempWarn: bit(11), vibAlarm: bit(14), vibWarn: bit(15) },
    rec: parseTrend(recBuf, scale, nowMs)[0] || null,
    rpm: rpm === 65534 || rpm === 65535 || rpm < 30 ? null : rpm,
    battV: u16(206) / 1000, runH: u32(76) / 3600, trendSec: u16(12), wakeSec: u16(10),
  };
}

// Download request: opcode 1 = trends after `from` (unix seconds; send the newest stored timestamp itself)
function requestBytes(opcode, from) {
  const b = Buffer.alloc(6); b[0] = opcode; b[1] = 0; b.writeUInt32LE(from >>> 0, 2); return b;
}

// Collects one bulk response: header first (count u16 @2, bytes u32 @4), then the payload
class BulkCollector {
  constructor(opcode) { this.opcode = opcode; this.chunks = []; this.got = 0; this.expected = null; }
  // returns true when complete
  push(data) {
    if (this.expected == null) {
      if (data.length !== HDR) return false;    // 10-byte busy packets can arrive first
      const n = data.readUInt16LE(2), nb = data.readUInt32LE(4);
      if (this.opcode === 1) { this.expected = HDR + n * REC; if (nb > 0 && nb % REC === 0 && nb !== n * REC) this.expected = HDR + nb; }
      else this.expected = nb > 0 ? HDR + nb : HDR;
      this.count = n;
      this.chunks.push(Buffer.from(data)); this.got = HDR;
      return this.got >= this.expected;
    }
    if (!data.length) return true;
    this.chunks.push(Buffer.from(data)); this.got += data.length;
    return this.got >= this.expected;
  }
  buffer() { return Buffer.concat(this.chunks); }
}

// Status the same way as the dashboard's "sensor thresholds" mode: per-axis warn/alarm, temperature
function judge(rec, thr) {
  if (!rec || !thr) return null;
  let z = 'ok';
  ['vx', 'vy', 'vz'].forEach((k, i) => {
    const v = rec[k]; if (v == null) return;
    if (thr.alarm[i] != null && v >= thr.alarm[i]) z = 'alarm';
    else if (thr.warn[i] != null && v >= thr.warn[i] && z !== 'alarm') z = 'warn';
  });
  if (rec.temp != null) {
    if (thr.ta != null && rec.temp >= thr.ta) z = 'alarm';
    else if (thr.tw != null && rec.temp >= thr.tw && z === 'ok') z = 'warn';
  }
  return z;
}

module.exports = { UUID, REC, HDR, parseTrend, parseSys, requestBytes, BulkCollector, judge };
