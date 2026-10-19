// What is set inside the sensor: the 220-byte system structure the page already reads at every connection,
// decoded field by field (offsets from the i-ALERT app, see ia3-sys-write.js / ialert3-protocol.md).
// READ ONLY: this file never writes to the sensor. The last copy read is kept per sensor (S.sensors[id].sysRaw),
// so it can be looked at later and on other devices. Loaded after machine-setup.js.

const hexOf=u8=>Array.from(u8,b=>b.toString(16).padStart(2,'0')).join('');
function dvFromHex(h){const u=new Uint8Array(h.length>>1);for(let i=0;i<u.length;i++)u[i]=parseInt(h.substr(i*2,2),16);return new DataView(u.buffer)}
// keep the newest copy; rewrite it only when a setting changed or once an hour (the clock changes at every read)
function keepSysRaw(id,dv){
  const sv=S.sensors[id];if(!sv||!dv||dv.byteLength<212)return;
  const hex=hexOf(new Uint8Array(dv.buffer,dv.byteOffset,dv.byteLength)),cfgPart=h=>h.slice(20,120)+h.slice(200,240);
  const old=sv.sysRaw;if(old&&cfgPart(old.hex)===cfgPart(hex)&&Date.now()-old.t<3600e3)return;
  if(old&&cfgPart(old.hex)!==cfgPart(hex)&&typeof appLog==='function')appLog('conn',`ค่าที่ตั้งในเซนเซอร์ของ "${sv.asset}" เปลี่ยนไปจากที่อ่านครั้งก่อน (ตั้งจากแอป i-ALERT)`);
  sv.sysRaw={t:Date.now(),hex};
}
// 9 bytes of 6-bit characters; only shown when it reads as normal text
function decodeTag(dv){
  const by=[];for(let i=102;i<111;i++)by.push(dv.getUint8(i));
  let bits='';for(const b of by)bits+=b.toString(2).padStart(8,'0');
  const tries=[bits,[...by].reverse().map(b=>b.toString(2).padStart(8,'0')).join('')];
  for(const t of tries){let s='';for(let i=0;i+6<=t.length;i+=6)s+=String.fromCharCode(parseInt(t.substr(i,6),2)+32);s=s.trim();
    if(s&&/^[A-Z0-9 _.\-\/#]+$/.test(s)&&/[A-Z0-9]/.test(s))return s}
  return null;
}
const ORI={1:'V',2:'H',3:'A'};
function sensorConfig(hex){
  const dv=dvFromHex(hex),s=parseSys(dv,816);if(!s)return null;
  const u8=o=>dv.getUint8(o),u16=o=>dv.getUint16(o,true),s16=o=>dv.getInt16(o,true),u32=o=>dv.getUint32(o,true);
  const vth=o=>{const v=u16(o);return v>=0xFFFF?null:Math.round(v/s.scale*25.4*1e3)/1e3};
  const set=u32(56),fo=u8(111);
  const ori={x:(set>>>8)&15||1,y:(set>>>4)&15||3,z:set&15||2};
  return{s,raw:hex,
    chk:[30,32,34].map(vth),runThr:u16(36),runMin:u16(38),band1:[u16(40),u16(42),u16(44)],band2:[u16(46),u16(48),u16(50)],tOff:s16(52)/100,
    lastParam:u32(64),syncTs:u32(72),basePts:u16(100),tag:decodeTag(dv),
    set:{raw:set,sdk:set>>>31&1,locked:set>>>30&1,claimed:set>>>29&1,pos:(set>>>12)&15||1,ori,oriAxes:{x:ORI[ori.x],y:ORI[ori.y],z:ORI[ori.z]}},
    fft:{low:fo&3,high:(fo>>2)&3,flux:(fo>>4)&3},mode:u8(117),rsbw:u8(114)};
}
function sysRawFor(a){let best=null;for(const[id,sv]of Object.entries(S.sensors||{}))if(sv.asset===a&&sv.sysRaw&&(!best||sv.sysRaw.t>best.r.t))best={id,r:sv.sysRaw};return best}
const fmtSec=s=>!s?'–':s%3600===0?`${s/3600} ชั่วโมง`:s%60===0?`${s/60} นาที`:`${s} วินาที`;
const tsTxt=t=>t&&t>1420070400?dFull(t*1000):'–';
function sensorConfigHtml(cf,readAt){
  const s=cf.s,mm=v=>v==null?'ไม่ได้ตั้ง':`${fv(v)} ${uv()}`,flag=(b,y,n='–')=>b?y:n;
  const axn={V:'Vertical (แนวตั้ง)',H:'Horizontal (แนวนอน)',A:'Axial (แนวเพลา)'};
  const row=(k,v)=>`<tr><td class="muted">${k}</td><td>${v}</td></tr>`;
  return`<p class="muted" style="margin:0 0 8px;font-size:12.5px">อ่านจากเซนเซอร์เมื่อ ${dFull(readAt)} · <b>อ่านอย่างเดียว</b> หน้าเว็บไม่เขียนค่าเหล่านี้ (แก้ได้ในแอป i-ALERT)</p>
  <div class="sc-grid">
  <div><h4>ตัวเซนเซอร์</h4><table class="ms-t"><tbody>
    ${row('รุ่น',s.devType===9?'i-ALERT3 Digital Accelerometer (9)':s.devType===8?'i-ALERT3 มาตรฐาน (8)':'device type '+s.devType)}
    ${row('Firmware rev',s.rev)}${row('MAC',s.mac?esc(s.mac):'–')}${row('Mode',cf.mode)}${cf.tag?row('Tag',esc(cf.tag)):''}
    ${row('แบตเตอรี่',s.battV.toFixed(2)+' V'+(s.flags.battery?' ⚠ ต่ำ':''))}${row('เวลาเดินสะสม',Math.round(s.runH).toLocaleString()+' ชม.')}</tbody></table></div>
  <div><h4>การวัด</h4><table class="ms-t"><tbody>
    ${row('บันทึก trend ทุก',fmtSec(s.trendSec))}${row('ตื่นเช็ก alarm ทุก',fmtSec(s.wakeSec))}
    ${row('ขนาดแพ็กเก็ต BLE',s.pkt+' ไบต์')}${row('FFT options (ID)',`ช่วงต่ำ ${cf.fft.low} · ช่วงสูง ${cf.fft.high} · flux ${cf.fft.flux}`)}${row('Run-speed bandwidth',cf.rsbw)}
    ${row('RPM ล่าสุด',s.rpm?s.rpm+' RPM':'ไม่มีสัญญาณ')}</tbody></table></div>
  <div><h4>เกณฑ์ที่ตั้งในเซนเซอร์</h4><table class="ms-t"><thead><tr><th>แกน</th><th class="num">Warning</th><th class="num">Alarm</th><th class="num">Alarm check</th></tr></thead><tbody>
    ${['x','y','z'].map((k,i)=>`<tr><td>${AXES[i][1]}</td><td class="num">${mm(s.thr.warn[i])}</td><td class="num">${mm(s.thr.alarm[i])}</td><td class="num">${mm(cf.chk[i])}</td></tr>`).join('')}
    <tr><td>อุณหภูมิ</td><td class="num">${s.thr.tw!=null?ft(s.thr.tw)+' °'+(S.tunit||'C'):'ไม่ได้ตั้ง'}</td><td class="num">${s.thr.ta!=null?ft(s.thr.ta)+' °'+(S.tunit||'C'):'ไม่ได้ตั้ง'}</td><td class="num muted">offset ${cf.tOff}</td></tr></tbody></table></div>
  <div><h4>การติดตั้ง (จากแอป)</h4><table class="ms-t"><tbody>
    ${['x','y','z'].map(k=>row('แกน '+k.toUpperCase(),axn[cf.set.oriAxes[k]]||'รหัส '+cf.set.ori[k])).join('')}
    ${row('ตำแหน่ง (รหัส)',cf.set.pos)}${row('ลงทะเบียน (claimed) / ล็อก',`${flag(cf.set.claimed,'ใช่','ไม่')} / ${flag(cf.set.locked,'ล็อก','ไม่ล็อก')}`)}</tbody></table>
    <p class="muted" style="font-size:11.5px;margin:4px 0 0">ทิศแกนตีความจากรหัสในแอป (ค่าเริ่มต้น X=Vertical, Y=Axial, Z=Horizontal) ควรตรวจกับของจริง</p></div>
  <div><h4>สถานะ</h4><table class="ms-t"><tbody>
    ${row('นาฬิกาเซนเซอร์',`${tsTxt(s.clock)} (${fmtDrift(s.clock-Math.floor(readAt/1000))})`)}${row('ตั้งเวลาแล้ว (time sync)',flag(s.status&0x10,'✓ ใช่','✗ ยัง'))}
    ${row('Baseline',(s.status&0x20?'✓ ตั้งแล้ว':'กำลังเก็บ')+` (${cf.basePts} จุด)`)}${row('เครื่องเดินอยู่',flag(s.flags.running,'ใช่','ไม่'))}
    ${row('Alarm ค้าง',[s.flags.vibAlarm&&'สั่นอันตราย',s.flags.vibWarn&&'สั่นเตือน',s.flags.tempAlarm&&'อุณหภูมิอันตราย',s.flags.tempWarn&&'อุณหภูมิเตือน'].filter(Boolean).join(', ')||'ไม่มี')}
    ${row('ตั้งค่าล่าสุด (จากแอป)',tsTxt(cf.lastParam))}${row('Alarm ล่าสุด',tsTxt(s.lastAlarm))}${row('FFT ตอน alarm ล่าสุด',tsTxt(s.lastAlarmFFT))}</tbody></table></div>
  <div><h4>ค่าอื่น (ค่าดิบ ยังไม่ทราบหน่วยแน่ชัด)</h4><table class="ms-t"><tbody>
    ${row('Running threshold',cf.runThr)}${row('Run min',cf.runMin)}${row('Band 1 เริ่ม/จบ/เกณฑ์',cf.band1.join(' / '))}${row('Band 2 เริ่ม/จบ/เกณฑ์',cf.band2.join(' / '))}
    ${row('Kurtosis X/Y/Z',s.kurt.map(v=>v.toFixed(2)).join(' / '))}</tbody></table></div>
  </div>
  <details style="margin-top:8px"><summary class="muted" style="font-size:12.5px">ข้อมูลดิบ 220 ไบต์ (hex)</summary><pre class="mono sc-raw">${cf.raw.match(/.{1,40}/g).map((l,i)=>String(i*20).padStart(3,' ')+'  '+l.match(/../g).join(' ')).join('\n')}</pre>
    <button type="button" class="btn sm" id="scCopy">คัดลอก</button></details>`;
}
function openSensorConfig(a){
  const got=sysRawFor(a);
  if(!got)return infoDialog('ค่าที่ตั้งในเซนเซอร์ · '+esc(a),'<p>ยังไม่มีข้อมูล เชื่อมต่อเซนเซอร์ของเครื่องนี้ 1 ครั้ง (ดึงข้อมูลหรืออ่านค่าสด) แล้วเปิดใหม่</p>');
  const cf=sensorConfig(got.r.hex);if(!cf)return toast('อ่านข้อมูลไม่ได้');
  const c=cfg(a),cur=sensorAxesOf(c),dif=['x','y','z'].some(k=>cur[k]!==cf.set.oriAxes[k])&&Object.values(cf.set.oriAxes).every(Boolean);
  infoDialog('ค่าที่ตั้งในเซนเซอร์ · '+esc(a),sensorConfigHtml(cf,got.r.t)+
    `<div class="row" style="margin-top:8px">${ble.device&&S.sensors[ble.device.id]&&S.sensors[ble.device.id].asset===a?'<button type="button" class="btn sm" id="scRead">อ่านค่าล่าสุดจากเซนเซอร์</button>':''}
     ${dif?`<button type="button" class="btn sm" id="scAxes">ใช้ทิศแกนตามแอปในเว็บ (${['x','y','z'].map(k=>k.toUpperCase()+'='+cf.set.oriAxes[k]).join(', ')})</button>`:''}</div>`);
  if($('#scCopy'))$('#scCopy').onclick=()=>navigator.clipboard.writeText(cf.raw).then(()=>toast('คัดลอกแล้ว'),()=>toast('คัดลอกไม่ได้'));
  if($('#scAxes'))$('#scAxes').onclick=()=>{specOf(c).axes={...cf.set.oriAxes};applyAxisNames(c);save();$('#infoDlg').close();render();toast('ตั้งทิศแกนตามแอปแล้ว')};
  if($('#scRead'))$('#scRead').onclick=async()=>{$('#infoDlg').close();await bleLiveRead();openSensorConfig(a)};
}
