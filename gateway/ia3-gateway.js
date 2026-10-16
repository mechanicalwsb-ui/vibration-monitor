#!/usr/bin/env node
// i-ALERT3 gateway for a Raspberry Pi: downloads trends from the sensors over Bluetooth every N minutes,
// keeps them on the Pi, serves the dashboard + data on the LAN, and sends LINE / Telegram alerts.
// Read-only towards the sensors: the only writes are bulk download requests, as in the dashboard.
//
//   node ia3-gateway.js [config.json]      normal run (needs @abandonware/noble and Bluetooth)
//   node ia3-gateway.js --mock             simulated sensor, for trying it on any computer
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), https = require('https');
const P = require('./protocol');

const args = process.argv.slice(2), MOCK = args.includes('--mock');
const cfgPath = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, 'config.json'));
const DEF = { sensors: [], intervalMin: 60, port: 8080, webRoot: '..', dataDir: './data', alertGapH: 6, dailyAt: '08:00',
  connectTimeoutSec: 25, scanTimeoutSec: 40, telegram: null, line: null };
let cfg;
try { cfg = { ...DEF, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) }; }
catch (e) { if (!MOCK) { console.error(`อ่าน ${cfgPath} ไม่ได้: ${e.message}\nคัดลอก config.example.json เป็น config.json แล้วแก้ค่าก่อน`); process.exit(1); } cfg = { ...DEF }; }
if (MOCK && !cfg.sensors.length) cfg.sensors = [{ mac: 'AA:BB:CC:DD:EE:01', asset: 'MOCK ปั๊มทดสอบ' }];
const base = path.dirname(cfgPath);
const dataDir = path.resolve(base, cfg.dataDir), webRoot = path.resolve(__dirname, cfg.webRoot);
fs.mkdirSync(dataDir, { recursive: true });
const log = (...a) => console.log(new Date().toLocaleString('th-TH'), ...a);

// ---------- state on disk ----------
const stateFile = path.join(dataDir, 'state.json');
let S = { readings: [], sensors: {}, health: {}, notified: {}, fails: {} };
try { S = { ...S, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch (e) {}
function saveState() { const tmp = stateFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(S)); fs.renameSync(tmp, stateFile); }

// ---------- alerts ----------
function post(url, body, headers = {}) {
  return new Promise(res => {
    const data = JSON.stringify(body), u = new URL(url);
    const req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      r => { let t = ''; r.on('data', d => t += d); r.on('end', () => res({ ok: r.statusCode < 300, status: r.statusCode, text: t })); });
    req.on('error', e => res({ ok: false, text: e.message })); req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}
async function send(text) {
  const out = [];
  if (cfg.telegram && cfg.telegram.token && cfg.telegram.chatId)
    out.push(post(`https://api.telegram.org/bot${cfg.telegram.token}/sendMessage`, { chat_id: cfg.telegram.chatId, text }));
  if (cfg.line && cfg.line.channelToken && cfg.line.to) // LINE Messaging API push (LINE Notify closed in 2025)
    out.push(post('https://api.line.me/v2/bot/message/push', { to: cfg.line.to, messages: [{ type: 'text', text }] },
      { Authorization: 'Bearer ' + cfg.line.channelToken }));
  const res = await Promise.all(out);
  res.forEach(r => { if (!r.ok) log('ส่งแจ้งเตือนไม่สำเร็จ:', r.status || '', (r.text || '').slice(0, 200)); });
  if (!out.length) log('(ยังไม่ได้ตั้ง Telegram/LINE) ข้อความ:', text);
}
function alertOnce(key, text) {
  const gap = cfg.alertGapH * 36e5;
  if (Date.now() - (S.notified[key] || 0) < gap) return;
  S.notified[key] = Date.now(); saveState(); send(text);
}
const fmt = v => v == null ? '–' : (+v).toFixed(2);

// ---------- Bluetooth ----------
let noble = null;
function getNoble() {
  if (MOCK) return null;
  if (!noble) {
    try { noble = require('@abandonware/noble'); }
    catch (e) { console.error('ยังไม่ได้ติดตั้ง noble: รัน  npm install  ในโฟลเดอร์ gateway ก่อน'); process.exit(1); }
  }
  return noble;
}
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' หมดเวลา')), ms))]);
async function waitPoweredOn(n) {
  if (n.state === 'poweredOn' || n._state === 'poweredOn') return;
  await withTimeout(new Promise(r => n.on('stateChange', s => { if (s === 'poweredOn') r(); })), 20000, 'เปิด Bluetooth');
}
// Find one sensor by its Bluetooth address (as shown in the i-ALERT app / chrome://bluetooth-internals)
async function findPeripheral(mac) {
  const n = getNoble(); await waitPoweredOn(n);
  const want = mac.toLowerCase();
  return withTimeout(new Promise((resolve, reject) => {
    const onDisc = p => { if ((p.address || '').toLowerCase() === want || (p.id || '').toLowerCase() === want.replace(/:/g, '')) { cleanup(); resolve(p); } };
    const cleanup = () => { n.removeListener('discover', onDisc); n.stopScanning(); };
    n.on('discover', onDisc);
    n.startScanning([], true, err => { if (err) { cleanup(); reject(err); } });
    setTimeout(() => { cleanup(); reject(new Error('ไม่เจอเซนเซอร์ ' + mac + ' (อยู่นอกระยะ หรือมีอุปกรณ์อื่นเชื่อมอยู่)')); }, cfg.scanTimeoutSec * 1000);
  }), cfg.scanTimeoutSec * 1000 + 2000, 'สแกน');
}
function bulk(ch, opcode, from) {
  return new Promise((resolve, reject) => {
    const col = new P.BulkCollector(opcode); let idle;
    const done = err => { clearTimeout(idle); ch.removeListener('data', onData); ch.unsubscribe(() => {}); err ? reject(err) : resolve(col.buffer()); };
    const arm = ms => { clearTimeout(idle); idle = setTimeout(() => col.expected == null ? done(new Error('เซนเซอร์ไม่ตอบ')) : done(), ms); };
    const onData = d => { if (col.push(d)) done(); else arm(45000); };
    ch.on('data', onData);
    ch.subscribe(err => {
      if (err) return done(err);
      arm(15000);
      ch.write(P.requestBytes(opcode, from), !ch.properties.includes('write'), e => { if (e) done(e); });
    });
  });
}
const pify = (fn, ...a) => new Promise((res, rej) => fn(...a, (e, ...r) => e ? rej(e) : res(r.length > 1 ? r : r[0])));

// One sensor: connect, read status, download new trends, disconnect
async function pollSensor(sc) {
  const key = sc.mac.toUpperCase(), st = S.sensors[key] || (S.sensors[key] = { asset: sc.asset, scale: sc.scale || 816 });
  st.asset = sc.asset;
  const last = S.readings.filter(r => r.asset === sc.asset).reduce((m, r) => Math.max(m, r.t), 0);
  const t0 = Date.now(); let sys = null, recs = [];
  if (MOCK) ({ sys, recs } = mockPoll(st, last));
  else {
    const p = await findPeripheral(sc.mac);
    try {
      await withTimeout(pify(p.connect.bind(p)), cfg.connectTimeoutSec * 1000, 'เชื่อมต่อ');
      const [, chars] = await withTimeout(pify(p.discoverSomeServicesAndCharacteristics.bind(p), [P.UUID.svc], [P.UUID.bulk, P.UUID.sys]), 20000, 'หา service');
      const ch = id => chars.find(c => c.uuid === id);
      if (!ch(P.UUID.bulk)) throw new Error('ไม่พบช่องรับข้อมูลของ i-ALERT3');
      if (ch(P.UUID.sys)) sys = P.parseSys(await pify(ch(P.UUID.sys).read.bind(ch(P.UUID.sys))), st.scale);
      if (sys) st.scale = sys.scale;
      const from = last ? Math.floor(last / 1000) : 0;
      recs = P.parseTrend(await bulk(ch(P.UUID.bulk), 1, from), st.scale);
    } finally { try { p.disconnect(); } catch (e) {} }
  }
  // merge
  const have = new Set(S.readings.filter(r => r.asset === sc.asset).map(r => r.t)); let added = 0;
  for (const r of recs) if (!have.has(r.t)) { S.readings.push({ ...r, asset: sc.asset }); have.add(r.t); added++; }
  if (sys) { st.mac = sys.mac || st.mac; st.thr = sys.thr; st.devType = sys.devType; }
  const h = S.health[key] || (S.health[key] = []);
  h.push({ t: Date.now(), ok: true, att: 1, ms: Date.now() - t0, ...(sys ? { batt: sys.battV, drift: Math.round(sys.clock - Date.now() / 1000), reset: !sys.clockOk,
    batLow: sys.flags.battery, rev: sys.rev, devType: sys.devType, trendSec: sys.trendSec, wakeSec: sys.wakeSec, runH: Math.round(sys.runH) } : {}) });
  if (h.length > 3000) h.splice(0, h.length - 3000);
  S.fails[key] = 0; st.lastOk = Date.now(); saveState();
  log(`${sc.asset}: เพิ่ม ${added} ค่า (รับ ${recs.length})${sys ? ` · แบต ${sys.battV.toFixed(2)} V` : ''}`);
  // alerts
  const newest = recs.sort((a, b) => a.t - b.t).at(-1);
  const z = P.judge(newest, st.thr);
  if (z === 'alarm' || z === 'warn')
    alertOnce(`${key}|${z}`, `${z === 'alarm' ? '⛔ อันตราย' : '⚠ เฝ้าระวัง'}: ${sc.asset}\nVelocity X/Y/Z ${fmt(newest.vx)}/${fmt(newest.vy)}/${fmt(newest.vz)} mm/s · ${fmt(newest.temp)} °C\n${new Date(newest.t).toLocaleString('th-TH')}`);
  if (sys && sys.flags.battery) alertOnce(key + '|bat', `🔋 แบตเซนเซอร์ต่ำ: ${sc.asset} (${sys.battV.toFixed(2)} V)`);
  if (sys && !sys.clockOk) alertOnce(key + '|clk', `⏱ นาฬิกาเซนเซอร์รีเซ็ต: ${sc.asset} — เปิดแอป i-ALERT เชื่อมต่อ 1 ครั้งเพื่อตั้งเวลา`);
}
let busy = false;
async function cycle() {
  if (busy) return; busy = true;
  for (const sc of cfg.sensors) {
    try { await pollSensor(sc); }
    catch (e) {
      const key = sc.mac.toUpperCase(); S.fails[key] = (S.fails[key] || 0) + 1;
      (S.health[key] || (S.health[key] = [])).push({ t: Date.now(), ok: false, att: 1, err: e.message }); saveState();
      log(`${sc.asset}: ไม่สำเร็จ (${S.fails[key]} ครั้งติด) — ${e.message}`);
      if (S.fails[key] === 3) alertOnce(key + '|fail', `ดึงข้อมูล ${sc.asset} ไม่สำเร็จ 3 ครั้งติด: ${e.message}`);
    }
  }
  busy = false;
}
// Daily summary
let lastDaily = '';
setInterval(() => {
  const now = new Date(), hm = now.toTimeString().slice(0, 5), day = now.toDateString();
  if (hm !== cfg.dailyAt || lastDaily === day) return; lastDaily = day;
  const lines = cfg.sensors.map(sc => {
    const st = S.sensors[sc.mac.toUpperCase()] || {}, r = S.readings.filter(x => x.asset === sc.asset).sort((a, b) => b.t - a.t)[0];
    const z = P.judge(r, st.thr);
    return `${z === 'alarm' ? '⛔' : z === 'warn' ? '⚠' : r ? '✅' : '❔'} ${sc.asset}: ${r ? `${fmt(Math.max(r.vx, r.vy, r.vz))} mm/s · ${fmt(r.temp)} °C` : 'ไม่มีข้อมูล'}`;
  });
  send(`สรุปประจำวัน ${now.toLocaleDateString('th-TH')}\n` + lines.join('\n'));
}, 30000);

// ---------- HTTP: dashboard files + data ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.svg': 'image/svg+xml' };
function backupJson() {
  const sensors = {};
  for (const [mac, st] of Object.entries(S.sensors)) sensors['gw:' + mac] = { asset: st.asset, scale: st.scale, mac: st.mac || mac, via: 'gateway' };
  return { format: 'vibmon-backup', version: 1, exportedAt: new Date().toISOString(), app: 'gateway',
    state: { readings: S.readings, sensors, health: S.health, assets: {} }, fft: [] };
}
http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const json = o => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  if (url === '/api/status') return json({ gateway: true, sensors: cfg.sensors.map(sc => ({ ...sc, ...S.sensors[sc.mac.toUpperCase()], fails: S.fails[sc.mac.toUpperCase()] || 0 })),
    readings: S.readings.length, intervalMin: cfg.intervalMin, busy });
  if (url === '/api/backup') return json(backupJson());
  if (url === '/api/poll' && req.method === 'POST') { cycle(); return json({ started: true }); }
  let file = path.join(webRoot, url === '/' ? 'index.html' : url);
  if (!file.startsWith(webRoot)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  });
}).listen(cfg.port, () => log(`เปิดแดชบอร์ดได้ที่ http://<ที่อยู่ Pi>:${cfg.port}/ · ข้อมูล /api/backup`));

// ---------- mock sensor (--mock) ----------
function mockPoll(st, last) {
  const now = Date.now(), step = 600e3, recs = [], from = last || now - 2 * 864e5;
  for (let t = Math.floor(from / step) * step + step; t <= now; t += step) {
    const b = Buffer.alloc(P.HDR + P.REC), k = (t - now) / 864e5;
    b.writeUInt32LE(Math.floor(t / 1000), P.HDR); b.writeInt16LE(Math.round((45 + Math.sin(t / 36e5) * 2) * 100), P.HDR + 4);
    [1.2, 0.9, 0.7].forEach((v, i) => b.writeUInt16LE(Math.round((v + 0.2 * (k + 2) + Math.random() * 0.1) / 25.4 * 816), P.HDR + 6 + i * 2));
    [0.1, 0.08, 0.07].forEach((v, i) => b.writeUInt16LE(Math.round(v * 816), P.HDR + 12 + i * 2));
    recs.push(...P.parseTrend(b, 816, now));
  }
  const s = Buffer.alloc(220); s.writeUInt16LE(1 << 9 | 1 << 4 | 1 << 5, 4); s.writeUInt32LE(Math.floor(now / 1000), 68);
  s[118] = 8; s[119] = 16; s.writeUInt16LE(2960, 172); s.writeUInt16LE(3580, 206); s.writeUInt16LE(3600, 12);
  [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x01].forEach((x, i) => s[212 + i] = x);
  [18, 20, 22].forEach(o => s.writeUInt16LE(Math.round(4.5 / 25.4 * 816), o)); [24, 26, 28].forEach(o => s.writeUInt16LE(Math.round(2.8 / 25.4 * 816), o));
  s.writeInt16LE(8500, 14); s.writeInt16LE(7000, 16);
  return { sys: P.parseSys(s, 816, now), recs };
}

log(`Gateway เริ่มทำงาน · ${cfg.sensors.length} เซนเซอร์ · ดึงทุก ${cfg.intervalMin} นาที${MOCK ? ' · โหมดจำลอง' : ''}`);
cycle();
setInterval(cycle, cfg.intervalMin * 60000);
