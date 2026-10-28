// Spot checks with a portable sensor: one i-ALERT3 carried from point to point, plus the sensor axis settings.
// Towards the sensor this file only reads, except writeSensorAxes(): the axis-direction write the user approved
// on 2026-10-28 (settings bytes 56-59 + the parameter timestamp 64-67, every other byte as read, read back after).
// A portable sensor never downloads its stored trends or alarm FFTs: it logs all the time, so its memory
// mixes every place it has been (pocket, walking, machine A, B ...). A spot reading is the average of the
// sensor's own alarm-check values taken after it was mounted, saved on the point the user picked.

// ---------- helpers (drafted by worker node autocad08 / gemma-4-e4b, reviewed and corrected) ----------
// mean/min/max/CV per axis of the values kept during one spot measurement; stable = every CV <= 15 %
function spotStats(samples){
  const empty={n:0,mean:[null,null,null],min:[null,null,null],max:[null,null,null],cv:[null,null,null],stable:false};
  if(!Array.isArray(samples))return empty;
  const ax=[[],[],[]];let n=0;
  for(const s of samples){if(!s||!Array.isArray(s.v))continue;let any=false;
    for(let i=0;i<3;i++){const v=s.v[i];if(typeof v==='number'&&isFinite(v)){ax[i].push(v);any=true}}if(any)n++}
  if(!n)return empty;
  const r=(v,d)=>+v.toFixed(d),st=vs=>{if(!vs.length)return{mean:null,min:null,max:null,cv:null};
    const m=vs.reduce((a,b)=>a+b,0)/vs.length,sd=Math.sqrt(vs.reduce((a,b)=>a+(b-m)**2,0)/vs.length);
    return{mean:r(m,4),min:r(Math.min(...vs),4),max:r(Math.max(...vs),4),cv:vs.length<2||m===0?0:r(sd/Math.abs(m),3)}};
  const S3=ax.map(st),cvs=S3.map(x=>x.cv);
  return{n,mean:S3.map(x=>x.mean),min:S3.map(x=>x.min),max:S3.map(x=>x.max),cv:cvs,stable:n>=2&&cvs.filter(c=>c!=null).every(c=>c<=0.15)};
}
// next spot check: 'never' / 'ok' / 'due' (within a day) / 'over'
function dueInfo(lastT,intervalDays,now){
  const D=864e5,t=typeof now==='number'&&isFinite(now)?now:Date.now(),days=intervalDays>0?intervalDays:30;
  if(lastT==null)return{state:'never',dueAt:null,daysLeft:null};
  const dueAt=lastT+days*D,left=dueAt-t;
  return{state:t>dueAt?'over':left<=D?'due':'ok',dueAt,daysLeft:Math.floor(left/D)};
}
// tap test: which axis rose most between two readings, and by how much more than the next one
function dominantAxis(before,after){
  if(!Array.isArray(before)||!Array.isArray(after)||before.length!==3||after.length!==3)return{axis:null,ratio:NaN,clear:false};
  const rise=[0,1,2].map(i=>{const d=after[i]-before[i];return isFinite(d)?Math.max(0,d):0}),ord=[0,1,2].sort((a,b)=>rise[b]-rise[a]);
  const hi=rise[ord[0]],lo=rise[ord[1]];if(!(hi>0))return{axis:null,ratio:NaN,clear:false};
  const ratio=lo>0?+(hi/lo).toFixed(2):Infinity;return{axis:ord[0],ratio,clear:ratio>=1.5};
}
// "?spot=<point>&m=<machine>" (QR links); URLSearchParams already decodes
function parseSpotParams(search){
  try{const p=new URLSearchParams(String(search||'')),g=k=>{const v=(p.get(k)||'').trim();return v&&v.length<=120?v:null};return{point:g('spot'),machine:g('m')}}
  catch(e){return{point:null,machine:null}}
}
// median of the first n finite values (the point's first spot checks), null until there are n
function baselineOf(values,n=3){
  if(!Array.isArray(values))return null;const f=[];
  for(const v of values){if(typeof v==='number'&&isFinite(v)){f.push(v);if(f.length>=n)break}}
  if(f.length<n||!f.length)return null;f.sort((a,b)=>a-b);const k=f.length;
  return+(k%2?f[(k-1)/2]:(f[k/2-1]+f[k/2])/2).toFixed(4);
}

// ---------- sensor type: fixed (default) or portable; the same physical sensor can sit under several
// browser ids (one per tablet/browser), so the setting follows the MAC ----------
const sibIds=id=>{const sv=S.sensors[id];if(!sv)return[];return sv.mac?Object.keys(S.sensors).filter(k=>S.sensors[k].mac===sv.mac):[id]};
function sensorMode(id){let best=null;for(const k of sibIds(id)){const x=S.sensors[k];if(x.mode&&(!best||(x.modeT||0)>(best.modeT||0)))best=x}return best?best.mode:'fixed'}
const isPortable=id=>!!id&&!!S.sensors[id]&&sensorMode(id)==='portable';
const portableIds=()=>Object.keys(S.sensors||{}).filter(id=>!id.startsWith('gw:')&&isPortable(id));
function setSensorMode(id,mode){
  const sv=S.sensors[id];if(!sv)return;const t=Date.now();
  for(const k of sibIds(id)){const x=S.sensors[k];Object.assign(x,{mode,modeT:t});
    if(mode==='portable'){x.mount='magnet';if(x.sched)x.sched.on=false;if(x.cond)x.cond.on=false}}
  if(typeof appLog==='function')appLog('set',`เซนเซอร์ ${sv.mac||id.slice(0,8)}: ตั้งเป็น${mode==='portable'?'แบบพกพา (วัดรายจุด, ฐานแม่เหล็ก)':'แบบติดตั้งถาวร'}`);
  if(ble.device&&sibIds(id).includes(ble.device.id)&&ble.cfg){ble.cfg.portable=mode==='portable';if(mode==='portable'){ble.cfg.asset=SPOT.point||null;clearInterval(ble.timer);ble.timer=null}else ble.cfg.asset=sv.asset}
  save();
}
// battery: the manual rates battery life for 1 connection a day and 1 tri-axial FFT per 14 days
function portableBudgetHtml(id){
  const sv=S.sensors[id]||{},key=sv.mac||id,since=Date.now()-30*DAY,conn=(S.health[key]||[]).filter(h=>h.t>=since).length,fft=fftTimesOf(id).filter(t=>t>=since).length;
  const hi=conn>90||fft>6;
  return`<span class="tag ${hi?'zC':''}" title="คู่มือคิดอายุแบตที่ เชื่อมต่อวันละ 1 ครั้ง (~30/เดือน) และ FFT 3 แกน 1 ครั้งต่อ 14 วัน (~2/เดือน) ใช้มากกว่านี้แบตจะหมดเร็วขึ้น">30 วัน: เชื่อมต่อ ${conn} · FFT ${fft}${hi?' · ใช้แบตมาก':''}</span>`;
}
const sensorLabel=id=>{const sv=S.sensors[id]||{};return isPortable(id)?`เซนเซอร์พกพา${sv.mac?' '+sv.mac.slice(-5):''}`:sv.asset};

// ---------- axis directions ----------
// Codes in the sensor's settings word: 1 Vertical, 2 Horizontal, 3 Axial (the app's CSV export and its defaults).
// The app also offers "Radial"; its code is learnt from a sensor the user set to Radial in the app (S.oriCodes).
const ORI_KNOWN={1:'V',2:'H',3:'A'};
function oriMap(){return Object.assign({},ORI_KNOWN,S.oriCodes||{})}
const oriCodeOf=v=>{const m=oriMap();const k=Object.keys(m).find(c=>m[c]===v);return k?+k:null};
const AX_TH={V:'แนวตั้ง',H:'แนวนอน',A:'แนวแกนเพลา',R:'แนวรัศมี'};
const AX_DEFAULT={x:'V',y:'A',z:'H'}; // i-ALERT3 default (app: ox 1, oy 3, oz 2)
// orientation stored in a sensor record, from its last system-structure read
const ORI_CACHE=new Map();
function sensorOri(id){const sv=S.sensors[id];if(!sv||!sv.sysRaw||typeof sensorConfig!=='function')return null;
  const key=sv.sysRaw.hex+'|'+JSON.stringify(S.oriCodes||{}),hit=ORI_CACHE.get(id);if(hit&&hit.key===key)return hit.set;
  const cf=sensorConfig(sv.sysRaw.hex),set=cf?cf.set:null;ORI_CACHE.set(id,{key,set});return set}
const assetOfCfg=c=>Object.keys(S.assets||{}).find(k=>S.assets[k]===c);
// the sensor's orientation for a point: its fixed sensor, else the portable sensor that measures it
function axesFromSensor(c,a){
  a=a||assetOfCfg(c);if(!a)return null;
  let set=null;
  const fixed=Object.keys(S.sensors||{}).filter(id=>S.sensors[id].asset===a&&!isPortable(id)&&S.sensors[id].sysRaw).sort((x,y)=>S.sensors[y].sysRaw.t-S.sensors[x].sysRaw.t)[0];
  if(fixed)set=sensorOri(fixed);
  else if(isSpotPoint(a)){const p=portableIds().filter(id=>S.sensors[id].sysRaw).sort((x,y)=>S.sensors[y].sysRaw.t-S.sensors[x].sysRaw.t)[0];if(p)set=sensorOri(p)}
  if(!set)return null;const o=set.oriAxes;
  return{x:o.x||'?',y:o.y||'?',z:o.z||'?',src:'sensor',unknown:['x','y','z'].filter(k=>!o[k]).map(k=>k+'='+set.ori[k])};
}
const axTxt=o=>['x','y','z'].map(k=>k.toUpperCase()+'='+(o[k]||'?')).join(' ');

// ---------- spot points ----------
const isSpotPoint=a=>!!(S.assets[a]&&S.assets[a].spec&&S.assets[a].spec.spot);
const SPOT_EVERY={A:7,B:14,C:30};
const spotEvery=a=>{const s=(cfg(a).spec)||{};return s.spotEvery>0?s.spotEvery:SPOT_EVERY[critOf(cfg(a))]||30};
const lastSpot=a=>series(a).filter(r=>r.src==='spot').at(-1)||null;
const spotDue=a=>{const l=series(a).at(-1);return dueInfo(l?l.t:null,spotEvery(a))};
// every point a spot round can visit: points marked for spot checks, with or without readings yet
function allPoints(){return[...new Set([...names(),...Object.keys(S.assets||{})])].filter(a=>S.assets[a])}
function spotMachines(){
  const ms=new Map();
  for(const a of allPoints()){const m=machineOf(a);if(!ms.has(m))ms.set(m,[]);ms.get(m).push(a)}
  if(SPOT.newMachine&&!ms.has(SPOT.newMachine))ms.set(SPOT.newMachine,[]);
  if(typeof machineCatalog==='function')for(const m of machineCatalog())if(!ms.has(m))ms.set(m,[]);
  const rank={over:0,never:1,due:2,ok:3};
  return[...ms].map(([m,pts])=>{const sp=pts.filter(isSpotPoint),dues=sp.map(spotDue),worst=dues.sort((x,y)=>rank[x.state]-rank[y.state])[0]||null;
      const last=Math.max(0,...pts.map(a=>(series(a).at(-1)||{}).t||0));
      return{m,pts,sp:sp.length,due:worst,last:last||null}})
    .sort((x,y)=>(!!y.sp-!!x.sp)||((x.due?rank[x.due.state]:9)-(y.due?rank[y.due.state]:9))||x.m.localeCompare(y.m,'th'));
}
const dueTag=d=>!d?'':d.state==='over'?`<span class="tag zD">เลยกำหนด ${-d.daysLeft} วัน</span>`:d.state==='due'?'<span class="tag zC">ถึงกำหนด</span>':d.state==='never'?'<span class="tag">ยังไม่เคยวัด</span>':`<span class="tag zA">อีก ${d.daysLeft} วัน</span>`;
const POINT_SUG=['มอเตอร์ NDE','มอเตอร์ DE','ปั๊ม DE','ปั๊ม NDE','พัดลม DE','พัดลม NDE','เกียร์ขาเข้า','เกียร์ขาออก','เทอร์ไบน์ DE','เทอร์ไบน์ NDE'];
const MOUNT_HINT='วางบนเสื้อลูกปืน บนแผ่นรอง ให้ไฟ LED ขนานแนวเพลา';

// ---------- wizard state (kept on this device only: S.spotRun is not synced) ----------
const SPOT={step:1,machine:null,point:null,newMachine:null,q:''};
const SP={timer:null,prev:null,samples:[],t0:0,until:0,settle:30000,need:2,wake:null,lastS:null,err:''};
function spotRestore(){const r=S.spotRun;if(r&&Date.now()-r.at<12*36e5)Object.assign(SPOT,{step:Math.min(r.step||1,2),machine:r.machine||null,point:r.point||null,done:r.done||[]});else SPOT.done=[]}
function spotKeep(){S.spotRun={step:SPOT.step,machine:SPOT.machine,point:SPOT.point,done:SPOT.done||[],at:Date.now()};save()}
function spotGo(step,patch){spotStop();Object.assign(SPOT,patch||{},{step});spotKeep();if(SPOT.point&&ble.cfg&&ble.cfg.portable)ble.cfg.asset=SPOT.point;renderSpot()}
function openSpot(point,opt={}){if(!SPOT.done)spotRestore();SPOT.fromRoute=!!opt.fromRoute;
  if(point&&S.assets[point]){SPOT.machine=machineOf(point);SPOT.point=point;SPOT.step=3}
  S.view='spot';save();render()}

// the connected device, if it is a portable sensor
const portableNow=()=>ble.device&&isPortable(ble.device.id)?ble.device:null;
// A sensor picked from this page and still set as fixed is offered as the portable one (one confirm),
// so "connected but the spot page says not connected" cannot happen silently.
function askPortable(id){
  const sv=S.sensors[id];if(!sv||isPortable(id))return true;
  if(!confirm('เซนเซอร์ที่เชื่อมต่อ ('+(sv.mac||sv.asset)+') ตั้งไว้เป็น "ติดตั้งถาวร" ที่จุด "'+sv.asset+'"\n\nใช้ตัวนี้เป็นเซนเซอร์พกพา (วัดรายจุด) ไหม?\n• ไม่ดึงข้อมูลย้อนหลังจากตัวนี้อีก (ข้อมูลในเซนเซอร์จะปนหลายจุด)\n• ปิด "สั่งวัด FFT ตามตาราง" ของตัวนี้ · ฐานติดตั้งเป็นฐานแม่เหล็ก\n• ข้อมูลเก่าของ "'+sv.asset+'" อยู่ที่เดิม · เปลี่ยนกลับได้ในหน้าเซนเซอร์\n\nกด OK เพื่อใช้เป็นเซนเซอร์พกพา'))return false;
  setSensorMode(id,'portable');return true;
}
async function spotConnect(){
  if(ble.busy)return toast('รอให้งานกับเซนเซอร์เสร็จก่อน');
  if(portableNow())return spotReadOnce();
  // a fixed sensor already connected on this page: offer it instead of opening the chooser again
  if(ble.device&&S.sensors[ble.device.id]){if(!askPortable(ble.device.id))return;return spotOnConnect()}
  try{await loadKnownSensors()}catch(e){}
  const id=portableIds().find(i=>scan.known&&scan.known.has(i));
  if(id)return useDevice(scan.known.get(id));
  toast('เลือกเซนเซอร์ที่จะใช้เป็นเซนเซอร์พกพาจากหน้าต่างของ Chrome');
  SPOT.wantPortable=true;
  try{await pickAndUse()}finally{SPOT.wantPortable=false}
}
// called by useDevice() for a portable sensor instead of a trend download
async function spotOnConnect(){
  bleLog('เซนเซอร์พกพา: ไม่ดึงข้อมูลย้อนหลัง (ข้อมูลในเซนเซอร์ปนหลายจุด) อ่านเฉพาะสถานะและค่าสด');
  await spotReadOnce();
  if(S.view!=='spot'){S.view='spot';save()}
  render();
}
// one read of the system structure (read-only; the clock is set first if the sensor lost it, as the app does)
async function spotReadOnce(keep){
  const dev=ble.device;if(!dev||ble.busy)return null;
  if(typeof MM!=='undefined'&&MM.on){toast('กำลังวัดทั้งเครื่องอยู่ รอให้เสร็จก่อน');return null}
  ble.busy=true;updateBleButton();let err=null,s=null;const t0=Date.now();ble.attempts=0;
  try{
    const ch=await bleConnect(dev,SP.timer?2:4);if(!ch.sys)throw new Error('ไม่พบช่องสถานะของเซนเซอร์');
    s=parseSys(await rd(ch.sys),ble.cfg.scale);if(!s)throw new Error('อ่านสถานะเซนเซอร์ได้ไม่ครบ');
    if(s.mac&&S.sensors[dev.id])for(const k of sibIds(dev.id).concat(dev.id))S.sensors[k].mac=S.sensors[k].mac||s.mac;
    if(timeSyncNeeded(s)&&!SP.timer){try{const s2=await autoSyncTime(ch,dev);if(s2)Object.assign(s,s2)}catch(e){bleLog('ตั้งเวลาอัตโนมัติไม่สำเร็จ: '+e.message)}}
    applySys(s);SP.lastS=s;SP.wake=s.wakeSec||null;SP.err='';
  }catch(e){err=e;SP.err=e.message;bleLog('อ่านค่าจากเซนเซอร์พกพาไม่ได้: '+e.message)}
  finally{
    ble.busy=false;
    if(!SP.timer&&!keep)try{if(dev.gatt.connected)dev.gatt.disconnect()}catch(e){}
    if(!SP.timer)recordHealth(dev,s,{ok:!err,attempts:ble.attempts,ms:Date.now()-t0});
    bleFinish(dev,err);
  }
  return s;
}

// ---------- measuring: poll the sensor while it sits on the point, keep each new alarm-check value ----------
// The alarm-check values (velocity/acceleration X/Y/Z) are refreshed once per wake-up interval of the sensor,
// so a value is only used when it changed after the settle time (it was measured on the machine).
const sigOf=s=>s?[...s.checkV,...s.checkG].join(','):'';
function spotStart(){
  if(!portableNow())return toast('เชื่อมต่อเซนเซอร์พกพาก่อน');
  spotStop();ble.cfg.asset=SPOT.point;
  Object.assign(SP,{samples:[],prev:null,t0:Date.now(),until:Date.now()+15*60000,err:''});
  const wake=SP.wake||60,every=Math.max(4000,Math.min(15000,wake*1000/3));
  SP.need=wake>300?1:2;
  bleLog(`วัดรายจุด "${SPOT.point}": รอค่านิ่ง ${Math.round(SP.settle/1000)} วินาที แล้วเก็บค่าที่เซนเซอร์วัดใหม่ ${SP.need} ครั้ง (เซนเซอร์อัปเดตทุก ${wake} วินาที)`);
  SP.timer=setInterval(spotTick,every);spotTick();renderSpot();
}
function spotStop(){if(!SP.timer)return;clearInterval(SP.timer);SP.timer=null;
  try{if(ble.device&&ble.device.gatt.connected&&!ble.busy)ble.device.gatt.disconnect()}catch(e){}}
async function spotTick(){
  if(!SP.timer||ble.busy)return;
  if(Date.now()>SP.until){spotStop();toast('หยุดรอแล้ว (ครบ 15 นาที) บันทึกค่าที่ได้หรือเริ่มใหม่');renderSpot();return}
  const s=await spotReadOnce(true);if(!SP.timer)return;
  if(s){const sig=sigOf(s);
    if(SP.prev===null)SP.prev=sig; // value from before/at mounting: not used
    else if(sig!==SP.prev){SP.prev=sig;
      if(Date.now()-SP.t0>=SP.settle){SP.samples.push({t:Date.now(),v:s.checkV.slice(),g:s.checkG.slice(),k:s.kurt.slice(),rpm:s.rpm});
        bleLog(`วัดรายจุด: ได้ค่าใหม่ครั้งที่ ${SP.samples.length} · ${s.checkV.map(v=>fv(v)).join(' / ')} ${uv()}`)}}}
  if(SP.samples.length>=SP.need){spotStop();SPOT.step=4;spotKeep();toast('ได้ค่าครบแล้ว')}
  renderSpot();
}
function spotResult(){
  const v=spotStats(SP.samples.map(x=>({t:x.t,v:x.v}))),g=spotStats(SP.samples.map(x=>({t:x.t,v:x.g})));
  const k=spotStats(SP.samples.map(x=>({t:x.t,v:x.k}))),rpm=SP.samples.map(x=>x.rpm).filter(x=>x!=null);
  return{v,g,k,rpm:rpm.length?Math.round(rpm.reduce((a,b)=>a+b,0)/rpm.length):null};
}
function spotSave(note){
  const a=SPOT.point,res=spotResult();if(!a||!res.v.n)return toast('ยังไม่มีค่าที่วัดได้');
  const dev=ble.device,sv=dev&&S.sensors[dev.id]||{},c=cfg(a),ax=sensorAxesOf(c,a);
  const r={asset:a,t:Date.now(),vx:res.v.mean[0],vy:res.v.mean[1],vz:res.v.mean[2],ax:res.g.mean[0],ay:res.g.mean[1],az:res.g.mean[2],
    src:'spot',dev:sv.mac||(dev&&dev.id)||null,axes:{x:ax.x,y:ax.y,z:ax.z},mount:'magnet',n:res.v.n,stable:res.v.stable,
    cv:+Math.max(0,...res.v.cv.filter(x=>x!=null)).toFixed(3),...(res.rpm!=null?{rpm:res.rpm}:{}),...(note?{note}:{})};
  specOf(c).spot=true;
  // one reading above the limits asks for a second measurement; the second in a row alarms (checkAlerts)
  const z=status(r,c),prev=series(a).filter(x=>x.src==='spot').at(-1),pz=prev&&status(prev,c);
  if((z==='C'||z==='D')&&!(prev&&r.t-prev.t<7*DAY&&(pz==='C'||pz==='D')))r.recheck=true;
  S.readings.push(r);
  S.maint.push({id:uid(),asset:a,t:r.t,type:'ตรวจ',text:`วัดรายจุด ${fv(overall(r))} ${uv()}${z?' ('+ZL[z]+')':''}${note?' — '+note:''}`,by:S.lastBy||''});
  (SPOT.done=SPOT.done||[]).includes(a)||SPOT.done.push(a);
  if(typeof appLog==='function')appLog('data',`วัดรายจุด "${a}": ${axTxt(r.axes)} · ${[r.vx,r.vy,r.vz].map(v=>fv(v)).join(' / ')} ${uv()} (เฉลี่ย ${r.n} ค่า${r.stable?'':' · ค่ายังแกว่ง'})`);
  save();
  if(r.recheck)toast('ค่าเกินเกณฑ์ ควรวัดซ้ำอีกครั้งเพื่อยืนยัน (จะแจ้งเตือนเมื่อวัดซ้ำแล้วยังเกิน)');else checkAlerts(a,[r]);
  SP.samples=[];
  if(SPOT.fromRoute){SPOT.fromRoute=false;ble.last=Date.now();spotGo(1,{point:null});setView('route');return}
  const next=spotNextPoint();
  if(next)spotGo(3,{point:next});else spotGo(1,{point:null});
}
// next point of this machine not measured in this round
function spotNextPoint(){const pts=allPoints().filter(a=>machineOf(a)===SPOT.machine);return pts.find(a=>a!==SPOT.point&&!(SPOT.done||[]).includes(a)&&isSpotPoint(a))||null}

// ---------- page ----------
function spotSteps(){return`<div class="sp-dots">${[1,2,3,4].map(i=>`<i class="${i<=SPOT.step?'on':''}"></i>`).join('')}</div>`}
function renderSpot(){
  const p=$('#spotPage');if(!p||S.view!=='spot')return;
  if(!SPOT.done)spotRestore();
  const dev=portableNow(),conn=dev?`<span class="tag zA">เชื่อมต่อเซนเซอร์พกพาแล้ว</span>`:`<button class="btn sm" id="spConn">เชื่อมต่อเซนเซอร์พกพา</button>`;
  const head=t=>`<div class="mainhead"><h2>วัดรายจุด</h2><div class="row">${conn}${SPOT.step>1?'<button class="btn sm" id="spBack">← ย้อนกลับ</button>':''}</div></div>${spotSteps()}<div class="sp-st muted">ขั้น ${SPOT.step} / 4 · ${t}</div>`;
  let body='';
  if(SPOT.step===1){
    const list=spotMachines().filter(x=>!SPOT.q||x.m.toLowerCase().includes(SPOT.q.toLowerCase()));
    const dueN=spotMachines().filter(x=>x.due&&(x.due.state==='over'||x.due.state==='due')).length;
    body=head('เลือกเครื่องจักร')+`<div class="panel pbody sp-card">
      <div class="row"><input id="spQ" placeholder="ค้นหาเครื่องจักร" value="${esc(SPOT.q)}" style="flex:1;min-width:0"></div>
      <p class="muted" style="margin:8px 0 0;font-size:12.5px">${dueN?`ถึงกำหนดตรวจ ${dueN} เครื่อง · `:''}หรือสแกน QR ที่ติดเครื่องด้วยกล้องมือถือ</p>
      <div class="sp-list">${list.map(x=>`<button class="sp-row" data-m="${esc(x.m)}"><span><b>${esc(x.m)}</b><small>${x.pts.length?`${x.pts.length} จุด${x.sp?` · วัดรายจุด ${x.sp}`:''} · `:''}${x.last?'วัดล่าสุด '+ago(x.last):'ยังไม่มีข้อมูล'}</small></span>${x.sp?dueTag(x.due):''}</button>`).join('')||'<p class="muted">ไม่พบเครื่อง</p>'}</div>
      <button class="sp-add" id="spAddM">+ เพิ่มเครื่องจักรใหม่</button>
      <div id="spNewM" hidden class="sp-form"><label>ชื่อเครื่องจักร<input id="spMName" list="spMList" placeholder="พิมพ์แล้วเลือกจากรายชื่อ"><datalist id="spMList">${typeof catalogOptions==='function'?catalogOptions():''}</datalist></label>
        <label>ต้นกำลัง<select id="spMDrv"><option value="motor">มอเตอร์</option><option value="turbine">เทอร์ไบน์</option></select></label>
        <div class="row"><button class="btn primary" id="spMOk">เพิ่มแล้วเลือกจุดวัด</button><button class="btn" id="spMNo">ยกเลิก</button></div>
        <p class="muted" style="margin:0;font-size:12px">ข้อมูลอื่นกรอกทีหลังได้ในหน้า "ตั้งค่าเครื่องจักร"</p></div>
      <div class="row" style="margin-top:10px"><button class="btn sm" id="spRep">รายงานการวัดรายจุด</button>${dueN?'<button class="btn sm" id="spRoute">สร้างเส้นทางจากเครื่องที่ถึงกำหนด</button>':''}</div></div>`;
  }else if(SPOT.step===2){
    const m=SPOT.machine,pts=allPoints().filter(a=>machineOf(a)===m),next=pts.find(a=>isSpotPoint(a)&&!(SPOT.done||[]).includes(a));
    body=head(esc(m)+' · เลือกจุดวัด')+`<div class="panel pbody sp-card"><div class="sp-list">${pts.map(a=>{const c=cfg(a),fixed=Object.values(S.sensors).some(v=>v.asset===a&&!v.mode),done=(SPOT.done||[]).includes(a),ax=sensorAxesOf(c,a);
        return`<button class="sp-row${a===next?' next':''}" data-p="${esc(a)}"><span><b>${esc(pointLabel(a))}</b><small>${esc((c.spec&&c.spec.mountHint)||MOUNT_HINT)} · ${axTxt(ax)}${fixed?' · มีเซนเซอร์ถาวร':''}</small></span>${done?'<span class="tag zA">✓ วัดแล้ว</span>':a===next?'<span class="tag">ถัดไป</span>':isSpotPoint(a)?dueTag(spotDue(a)):''}</button>`}).join('')||'<p class="muted">เครื่องนี้ยังไม่มีจุดวัด</p>'}</div>
      <button class="sp-add" id="spAddP">+ เพิ่มจุดวัด</button>
      <div id="spNewP" hidden class="sp-form">
        <label>ชื่อจุดวัด<input id="spPName" list="spPSug" placeholder="มอเตอร์ DE"><datalist id="spPSug">${POINT_SUG.map(x=>`<option value="${x}">`).join('')}</datalist></label>
        <label>คำแนะนำการวาง (ขึ้นให้ผู้วัดอ่าน)<input id="spPHint" value="${esc(MOUNT_HINT)}"></label>
        <label class="check"><input type="checkbox" id="spPOwn"> จุดนี้วางแบบพิเศษ ตั้งทิศแกนเฉพาะจุด (เช่น ปั๊มตั้ง)</label>
        <div id="spPAx" hidden class="row">${['x','y','z'].map(k=>`<label>${k.toUpperCase()}<select data-pax="${k}">${['V','H','A','R'].map(v=>`<option value="${v}" ${AX_DEFAULT[k]===v?'selected':''}>${AXN[v]}</option>`).join('')}</select></label>`).join('')}</div>
        <div class="row"><button class="btn primary" id="spPOk">เพิ่มแล้ววัดจุดนี้</button><button class="btn" id="spPNo">ยกเลิก</button></div></div></div>`;
  }else if(SPOT.step===3){
    const a=SPOT.point,c=cfg(a),ax=sensorAxesOf(c,a),s=SP.lastS,run=!!SP.timer,left=Math.max(0,Math.ceil((SP.t0+SP.settle-Date.now())/1000));
    body=head(esc(pointLabel(a))+' · วางเซนเซอร์')+`<div class="panel pbody sp-card">
      <div class="sp-box"><b>${esc((c.spec&&c.spec.mountHint)||MOUNT_HINT)}</b><div class="muted">${esc(machineOf(a))} · ทิศแกน ${['x','y','z'].map(k=>`${k.toUpperCase()}=${AX_TH[ax[k]]||ax[k]}`).join(' · ')}${ax.unknown&&ax.unknown.length?' · <span class="up">มีรหัสทิศที่ยังไม่รู้จัก</span>':''}</div></div>
      ${!dev?(ble.device&&S.sensors[ble.device.id]?`<p>เชื่อมต่อเซนเซอร์ <b>${esc(S.sensors[ble.device.id].mac||S.sensors[ble.device.id].asset)}</b> อยู่ แต่ตั้งไว้เป็น "ติดตั้งถาวร" ที่จุด "${esc(S.sensors[ble.device.id].asset)}"</p><button class="btn primary big" id="spConn2">ใช้ตัวนี้เป็นเซนเซอร์พกพา</button>`:`<p>ยังไม่ได้เชื่อมต่อเซนเซอร์พกพา</p><button class="btn primary big" id="spConn2">เชื่อมต่อเซนเซอร์พกพา</button>`)
      :`<div class="sp-ring ${run?'on':''}">${run?(left>0?`<b>${left}</b><small>วินาที รอค่านิ่ง</small>`:`<b>${SP.samples.length}/${SP.need}</b><small>ค่าที่วัดใหม่</small>`):'<b>พร้อม</b><small>วางเซนเซอร์แล้วกดเริ่ม</small>'}</div>
        ${s?`<div class="sp-v">${['x','y','z'].map((k,i)=>`<div><small>${ax[k]}</small><b>${fv(s.checkV[i])}</b></div>`).join('')}</div><p class="muted" style="text-align:center;margin:0;font-size:12px">ค่าล่าสุดจากเซนเซอร์ (${uv()}) · เซนเซอร์อัปเดตค่าทุก ${SP.wake||'?'} วินาที${SP.wake>300?' · <span class="up">รอนาน แนะนำวัด FFT แทน</span>':''}</p>`:''}
        ${SP.err?`<p class="up" style="margin:0">${esc(SP.err)}</p>`:''}
        ${run?`<div class="row"><button class="btn big" id="spSkip" ${left>0?'':'disabled'}>ข้ามการรอ</button><button class="btn big" id="spStop">หยุด</button></div>`
          :`<button class="btn primary big" id="spStart">เริ่มวัด</button>${SP.samples.length?'<button class="btn big" id="spTo4">ใช้ค่าที่ได้แล้ว →</button>':''}`}`}
      <label class="check" style="margin-top:6px"><input type="checkbox" id="spSettle" ${SP.settle?'checked':''}> รอให้ค่านิ่ง 30 วินาทีหลังวาง</label></div>`;
  }else{
    const a=SPOT.point,c=cfg(a),res=spotResult(),v=res.v,ov=v.n?Math.max(...v.mean.filter(x=>x!=null)):null,z=v.n?vibZone(v.mean,c):null;
    const prev=series(a).filter(r=>r.src==='spot').at(-1),base=baselineOf(series(a).filter(r=>r.src==='spot').map(overall),3);
    body=head(esc(pointLabel(a))+' · ผลการวัด')+`<div class="panel pbody sp-card">
      <div class="sp-box sp-res"><div><b class="num">${fv(ov)} <small>${uv()}</small></b><div class="muted">ค่าสูงสุดของ 3 แกน · เฉลี่ย ${v.n} ค่า · ${v.stable?'ค่านิ่งดี':'<span class="up">ค่ายังแกว่ง</span>'}</div></div>${z?`<span class="tag z${z}">${ZL[z]}</span>`:''}</div>
      <div class="sp-v">${['x','y','z'].map((k,i)=>`<div><small>${sensorAxesOf(c,a)[k]}</small><b>${fv(v.mean[i])}</b></div>`).join('')}</div>
      <p class="muted" style="margin:0">${prev?`รอบก่อน ${fv(overall(prev))} ${uv()} (${ago(prev.t)})`:'ยังไม่มีค่ารอบก่อน'}${base!=null?` · ค่าฐาน ${fv(base)} ${uv()}`:''}${(z==='C'||z==='D')?' · <span class="up">เกินเกณฑ์ ควรวัดซ้ำ</span>':''}</p>
      <p class="muted" style="margin:0;font-size:12px">อุณหภูมิไม่บันทึก: ฐานแม่เหล็กทำให้อ่านต่ำกว่าผิวจริงประมาณ 22 °C</p>
      <button class="btn big" id="spFft" ${dev&&!ble.busy?'':'disabled'}>วัด FFT ด้วย</button>
      <input id="spNote" placeholder="หมายเหตุ เช่น เสียงดังผิดปกติ">
      <div class="row"><button class="btn big" id="spAgain">วัดใหม่</button><button class="btn primary big" id="spSave">บันทึก → ${esc((()=>{const n=spotNextPoint();return n?pointLabel(n):'เลือกเครื่องถัดไป'})())}</button></div></div>`;
  }
  p.innerHTML=body;spotBind();
}
function spotBind(){
  const p=$('#spotPage'),on=(id,f)=>{const e=p.querySelector('#'+id);if(e)e.onclick=f};
  on('spConn',spotConnect);on('spConn2',spotConnect);
  on('spBack',()=>spotGo(SPOT.step===4?3:SPOT.step-1));
  if(SPOT.step===1){
    const q=$('#spQ');q.oninput=()=>{SPOT.q=q.value;const pos=q.selectionStart;renderSpot();const n=$('#spQ');n.focus();n.setSelectionRange(pos,pos)};
    p.querySelectorAll('[data-m]').forEach(b=>b.onclick=()=>spotGo(2,{machine:b.dataset.m}));
    on('spAddM',()=>{$('#spNewM').hidden=false;$('#spMName').focus()});on('spMNo',()=>{$('#spNewM').hidden=true});
    on('spMOk',()=>{const n=$('#spMName').value.trim();if(!n)return toast('ใส่ชื่อเครื่องจักร');
      if(allPoints().some(a=>machineOf(a)===n))return spotGo(2,{machine:n});
      SPOT.newMachine=n;SPOT.newDrv=$('#spMDrv').value;
      if(typeof addCatalogMachine==='function'){addCatalogMachine(n,{'spec.driver':SPOT.newDrv});appLog('edit',`เพิ่มเครื่องจักร "${n}" ในรายชื่อ`);save()}
      spotGo(2,{machine:n})});
    on('spRep',spotReport);on('spRoute',spotMakeRoute);
  }else if(SPOT.step===2){
    p.querySelectorAll('[data-p]').forEach(b=>b.onclick=()=>{const a=b.dataset.p;if(!isSpotPoint(a)&&Object.values(S.sensors).some(v=>v.asset===a&&!v.mode)&&!confirm(`"${pointLabel(a)}" มีเซนเซอร์ติดตั้งถาวรอยู่แล้ว วัดรายจุดเพิ่ม (ใช้ยืนยันค่า) ไหม?`))return;spotGo(3,{point:a})});
    on('spAddP',()=>{$('#spNewP').hidden=false;$('#spPName').focus()});on('spPNo',()=>{$('#spNewP').hidden=true});
    const own=$('#spPOwn');if(own)own.onchange=()=>{$('#spPAx').hidden=!own.checked};
    on('spPOk',()=>{const pn=$('#spPName').value.trim();if(!pn)return toast('ใส่ชื่อจุดวัด');const m=SPOT.machine,a=`${m} ${pn}`;
      if(S.assets[a])return toast('มีจุดวัดชื่อนี้แล้ว');
      const c=cfg(a);c.machine=m;c.point=pn;const s=specOf(c);s.spot=true;s.mountHint=$('#spPHint').value.trim()||MOUNT_HINT;
      if(SPOT.newMachine===m&&SPOT.newDrv==='turbine')s.driver='turbine';
      if(own.checked){const ax={};p.querySelectorAll('[data-pax]').forEach(x=>ax[x.dataset.pax]=x.value);if(new Set(Object.values(ax)).size<3&&!Object.values(ax).includes('R'))return toast('แต่ละแกนควรเป็นคนละทิศ');s.axes=ax;s.axesSrc='point'}
      else s.axesSrc='sensor';
      if(typeof appLog==='function')appLog('edit',`เพิ่มจุดวัดรายจุด "${a}" (เครื่อง ${m})`);
      if(SPOT.newMachine===m)SPOT.newMachine=null;save();spotGo(3,{point:a})});
  }else if(SPOT.step===3){
    on('spStart',spotStart);on('spStop',()=>{spotStop();renderSpot()});on('spSkip',()=>{SP.t0=Date.now()-SP.settle;renderSpot()});
    on('spTo4',()=>spotGo(4));
    const st=$('#spSettle');if(st)st.onchange=()=>{SP.settle=st.checked?30000:0};
    if(SP.timer&&!SP._tick)SP._tick=setInterval(()=>{if(!SP.timer||S.view!=='spot'||SPOT.step!==3){clearInterval(SP._tick);SP._tick=null;return}const r=p.querySelector('.sp-ring b');if(r&&SP.t0+SP.settle>Date.now())r.textContent=Math.ceil((SP.t0+SP.settle-Date.now())/1000)},1000);
  }else{
    on('spAgain',()=>{SP.samples=[];spotGo(3)});
    on('spSave',()=>spotSave($('#spNote').value.trim()));
    on('spFft',async()=>{ble.cfg.asset=SPOT.point;await bleMeasureFFT();renderSpot()}); // bleMeasureFFT logs the FFT for the battery budget
  }
}
function spotMakeRoute(){
  const pts=allPoints().filter(isSpotPoint).filter(a=>{const d=spotDue(a);return d.state!=='ok'}).sort((x,y)=>machineOf(x).localeCompare(machineOf(y),'th'));
  if(!pts.length)return toast('ไม่มีจุดที่ถึงกำหนด');
  S.routes=S.routes||[];const r={id:uid(),name:'วัดรายจุด '+new Date().toLocaleDateString('th-TH'),assets:pts,spot:true};S.routes.push(r);save();
  toast(`สร้างเส้นทาง ${pts.length} จุดแล้ว`);setView('route');
}
// round report: spot readings of the chosen day (default today), one row per point
function spotReport(){
  const day=new Date();day.setHours(0,0,0,0);const t0=day.getTime()-6*DAY;
  const rows=allPoints().map(a=>{const sp=series(a).filter(r=>r.src==='spot'),r=sp.filter(x=>x.t>=t0).at(-1);if(!r)return null;const prev=sp.filter(x=>x.t<r.t).at(-1),c=cfg(a),z=status(r,c);
    return{a,r,prev,z,m:machineOf(a)}}).filter(Boolean).sort((x,y)=>x.m.localeCompare(y.m,'th')||x.a.localeCompare(y.a,'th'));
  if(!rows.length)return toast('ยังไม่มีการวัดรายจุดใน 7 วันนี้');
  const due=allPoints().filter(isSpotPoint).filter(a=>spotDue(a).state==='over');
  const html=`<h1>รายงานการวัดรายจุด</h1><p>ช่วง ${new Date(t0).toLocaleDateString('th-TH')} – ${new Date().toLocaleDateString('th-TH')} · วัด ${rows.length} จุด · หน่วย ${uv()}</p>
    <table><thead><tr><th>เครื่อง</th><th>จุดวัด</th><th>วันที่</th><th>X / Y / Z</th><th>รวม</th><th>รอบก่อน</th><th>สถานะ</th><th>หมายเหตุ</th></tr></thead><tbody>
    ${rows.map(x=>`<tr><td>${esc(x.m)}</td><td>${esc(pointLabel(x.a))}</td><td>${dFull(x.r.t)}</td><td>${[x.r.vx,x.r.vy,x.r.vz].map(v=>fv(v)).join(' / ')}<br><small>${axTxt(x.r.axes||{})}</small></td><td><b>${fv(overall(x.r))}</b></td><td>${x.prev?fv(overall(x.prev)):'–'}</td><td>${x.z?ZL[x.z]:'–'}${x.r.recheck?' (ควรวัดซ้ำ)':''}</td><td>${esc(x.r.note||'')}</td></tr>`).join('')}</tbody></table>
    ${due.length?`<h2>จุดที่เลยกำหนดตรวจ (${due.length})</h2><p>${due.map(a=>esc(a)).join(' · ')}</p>`:''}
    <p style="font-size:11px">วัดด้วยเซนเซอร์พกพา ฐานแม่เหล็ก ค่าที่ได้เป็นค่าเฉลี่ยของค่าที่เซนเซอร์วัดหลังวางเซนเซอร์ อุณหภูมิไม่ได้บันทึก</p>`;
  printHtml(html,'รายงานวัดรายจุด');
}

// ---------- sensor axis settings (dialog) ----------
const AX_COL={x:'#2e9b4b',y:'#d64545',z:'#2f6fd6'};
function sensorSvg(){return`<svg viewBox="0 0 280 160" class="ax-svg" role="img" aria-label="ภาพเซนเซอร์และแกน X Y Z">
  <g transform="translate(62,46)"><polygon points="20,30 112,0 164,30 72,64" fill="#2f7fe0"/><polygon points="20,30 72,64 72,104 20,70" fill="#1b5fb5"/><polygon points="72,64 164,30 164,70 72,104" fill="#164a8c"/><circle cx="92" cy="31" r="6" fill="#cfe2fb"/></g>
  <line x1="160" y1="112" x2="214" y2="146" stroke="${AX_COL.x}" stroke-width="3" marker-end="url(#ahx)"/><text x="222" y="152" fill="${AX_COL.x}" font-size="17" font-weight="600">X</text>
  <line x1="150" y1="78" x2="78" y2="40" stroke="${AX_COL.y}" stroke-width="3" marker-end="url(#ahy)"/><text x="58" y="38" fill="${AX_COL.y}" font-size="17" font-weight="600">Y</text>
  <line x1="182" y1="80" x2="182" y2="14" stroke="${AX_COL.z}" stroke-width="3" marker-end="url(#ahz)"/><text x="190" y="18" fill="${AX_COL.z}" font-size="17" font-weight="600">Z</text>
  <defs>${['x','y','z'].map(k=>`<marker id="ah${k}" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${AX_COL[k]}"/></marker>`).join('')}</defs></svg>`}
// id: sensor record (write to the sensor); a: point (axes for this point only). Either may be missing.
function openAxisDialog({id=null,a=null}={}){
  if(!id&&a){id=Object.keys(S.sensors).find(k=>S.sensors[k].asset===a&&!isPortable(k))||null}
  if(!id&&a&&isSpotPoint(a)){const n=portableNow();id=n?n.id:portableIds()[0]||null} // spot point: the portable sensor
  const so=id?sensorOri(id):null,pc=a?cfg(a):null,ps=pc?specOf(pc):null;
  const own=!!(ps&&ps.axes&&ps.axesSrc!=='sensor');
  const cur=own?ps.axes:so?{...AX_DEFAULT,...Object.fromEntries(Object.entries(so.oriAxes).filter(([,v])=>v))}:a?sensorAxesOf(pc,a):AX_DEFAULT;
  const hasR=!!oriCodeOf('R'),unknown=so?['x','y','z'].filter(k=>!so.oriAxes[k]).map(k=>so.ori[k]):[];
  const opt=(k,v)=>`<option value="${v}" ${cur[k]===v?'selected':''}>${AXN[v]} (${AX_TH[v]})</option>`;
  const canWrite=!!id&&!String(id).startsWith('gw:');
  const html=`<div class="ax-dlg">${sensorSvg()}
    <p style="text-align:center;font-weight:600;margin:4px 0 10px">ติดตั้งเซนเซอร์แบบไหน${a?' · '+esc(pointLabel(a)):''}</p>
    ${['z','y','x'].map(k=>`<label class="ax-f"><b style="color:${AX_COL[k]}">${k.toUpperCase()}</b><select data-axk="${k}">${['V','H','A','R'].map(v=>opt(k,v)).join('')}</select></label>`).join('')}
    ${so?`<p class="muted" style="font-size:12px;margin:8px 0 0">ตอนนี้ในเซนเซอร์: ${axTxt(so.oriAxes)}${unknown.length?` · มีรหัส ${unknown.join(', ')} ที่ยังไม่รู้จัก`:''}</p>`:''}
    ${unknown.length?`<div class="ms-box" style="margin-top:6px;font-size:12.5px">ถ้าในแอป i-ALERT เซนเซอร์ตัวนี้ตั้งแกนนั้นเป็น <b>Radial</b> กดยืนยันเพื่อให้เว็บรู้จักรหัสนี้ <button type="button" class="btn sm" id="axLearnR">รหัส ${unknown[0]} = Radial</button></div>`:''}
    ${!hasR?'<p class="muted" style="font-size:12px;margin:6px 0 0">Radial: ยังเขียนลงเซนเซอร์ไม่ได้จนกว่าจะรู้รหัส (ตั้งได้เฉพาะในเว็บ)</p>':''}
    <div class="ax-where">${canWrite?`<label class="check"><input type="radio" name="axTo" value="sensor" ${!own?'checked':''}> เขียนลงเซนเซอร์ (แอป i-ALERT จะเห็นค่าเดียวกัน)</label>`:''}
      ${a?`<label class="check"><input type="radio" name="axTo" value="point" ${own||!canWrite?'checked':''}> เฉพาะจุดนี้ในเว็บ (ไม่เขียนลงเซนเซอร์)</label>`:''}
      ${a&&own?'<label class="check"><input type="radio" name="axTo" value="clear"> ยกเลิกค่าเฉพาะจุด ใช้ตามเซนเซอร์</label>':''}</div>
    <div class="row" style="justify-content:space-between;margin-top:12px"><button type="button" class="btn" id="axDef">ค่าเริ่มต้น</button><button type="button" class="btn primary" id="axSave">บันทึก</button></div>
    <p class="muted" style="font-size:11.5px;margin:8px 0 0">ค่าเริ่มต้นของ i-ALERT3: X = Vertical, Y = Axial, Z = Horizontal · ตรวจกับของจริงด้วย "ทดสอบเคาะ" ในหน้าตั้งค่าเครื่องจักร</p></div>`;
  infoDialog('ทิศแกนเซนเซอร์'+(id?' · '+esc(sensorLabel(id)):''),html);
  const d=$('#infoDlg'),val=()=>{const o={};d.querySelectorAll('[data-axk]').forEach(s=>o[s.dataset.axk]=s.value);return o};
  d.querySelector('#axDef').onclick=()=>d.querySelectorAll('[data-axk]').forEach(s=>s.value=AX_DEFAULT[s.dataset.axk]);
  if(d.querySelector('#axLearnR'))d.querySelector('#axLearnR').onclick=()=>{S.oriCodes=Object.assign(S.oriCodes||{},{[unknown[0]]:'R'});
    if(typeof appLog==='function')appLog('set',`ทิศแกน: รหัส ${unknown[0]} ในเซนเซอร์ = Radial (ยืนยันจากแอป i-ALERT)`);save();d.close();openAxisDialog({id,a})};
  d.querySelector('#axSave').onclick=async()=>{
    const o=val(),to=(d.querySelector('input[name=axTo]:checked')||{}).value;
    if(!to)return toast('เลือกว่าจะใช้ค่านี้ที่ไหน');
    const vs=Object.values(o).filter(v=>v!=='R');if(new Set(vs).size<vs.length)return toast('แต่ละแกนต้องเป็นคนละทิศ (Radial ซ้ำได้)');
    if(to==='clear'){delete ps.axes;ps.axesSrc='sensor';save();d.close();applyAxisNames(pc);render();return toast('ใช้ทิศแกนตามเซนเซอร์แล้ว')}
    if(to==='point'){ps.axes=o;ps.axesSrc='point';if(typeof appLog==='function')appLog('set',`ทิศแกนเฉพาะจุด "${a}": ${axTxt(o)}`);save();d.close();applyAxisNames(pc);render();return toast('บันทึกทิศแกนของจุดนี้แล้ว')}
    if(Object.values(o).includes('R')&&!hasR)return toast('ยังเขียน Radial ลงเซนเซอร์ไม่ได้ (ยังไม่รู้รหัส) เลือก "เฉพาะจุดนี้ในเว็บ" แทน');
    d.close();
    const ok=await writeSensorAxes(id,o);
    if(ok&&ps&&ps.axes&&ps.axesSrc!=='sensor'){ps.axesSrc='sensor';save()}
    render();
  };
}

// ---------- the axis-direction write ----------
// Same packet as the app's system-structure write (ITTiAlert3MutableSystemStructure -> setRawSettings), but
// stricter: only the three orientation nibbles of the settings word (bits 0-11 @56) and lastParamTimestamp @64
// change; every other byte - position code, flags, upper bits, thresholds, baseline bit - is the sensor's own.
const ORI_WRITE_GAP_MS=120000;
function oriPreflight(read){
  if(read.length!==SYS_LEN)return['อ่านค่าตั้งค่าได้ไม่ครบ ('+read.length+' ไบต์)'];
  const dv=new DataView(read.buffer),q=dv.getUint32(0,true),dt=read[118],rev=read[119],why=[];
  if(dt!==8&&dt!==9)why.push('ไม่ใช่ i-ALERT3 แบบวัดการสั่น (device type '+dt+')');
  if(rev<10)why.push('firmware rev '+rev+' ยังไม่รองรับ');
  if(q!==0)why.push('เซนเซอร์มีคำสั่งค้างหรือกำลังทำงาน (queue 0x'+q.toString(16).padStart(8,'0')+') รอสักครู่แล้วลองใหม่');
  const set=dv.getUint32(56,true);if(!(set&0xF)||!((set>>4)&0xF)||!((set>>8)&0xF))why.push('ค่าทิศเดิมในเซนเซอร์ผิดรูปแบบ ไม่เขียนทับ ให้ตั้งในแอป i-ALERT');
  return why;
}
function buildOriWrite(read,codes,nowSec){
  for(const k of['x','y','z'])if(!(codes[k]>=1&&codes[k]<=15))throw new Error('รหัสทิศแกนไม่ถูกต้อง');
  const out=read.slice(),dv=new DataView(out.buffer),set=dv.getUint32(56,true);
  dv.setUint32(56,((set&~0xFFF)|(codes.x<<8)|(codes.y<<4)|codes.z)>>>0,true);
  dv.setUint32(64,nowSec>>>0,true);
  return out;
}
const ORI_BYTES=i=>(i>=56&&i<=57)||(i>=64&&i<=67); // the 12 orientation bits live in bytes 56-57
async function writeSensorAxes(id,axes){
  const dev=ble.device;
  if(!dev||!sibIds(id).concat(id).includes(dev.id)){toast('เชื่อมต่อเซนเซอร์ตัวนี้ก่อน แล้วกดบันทึกอีกครั้ง');return false}
  if(ble.busy||(typeof MM!=='undefined'&&MM.on)){toast('รอให้งานกับเซนเซอร์เสร็จก่อน');return false}
  const since=Date.now()-(S.lastOriWrite||0);if(since<ORI_WRITE_GAP_MS){toast(`เขียนทิศแกนได้อีกครั้งใน ${Math.ceil((ORI_WRITE_GAP_MS-since)/1000)} วินาที`);return false}
  const codes={};for(const k of['x','y','z']){codes[k]=oriCodeOf(axes[k]);if(!codes[k]){toast('ยังไม่รู้รหัสของ '+AXN[axes[k]]);return false}}
  if(SP.timer)spotStop();
  ble.busy=true;updateBleButton();let err=null,ok=false;
  try{
    const ch=await bleConnect(dev);
    if(!ch.sys||!(ch.sys.properties.write||ch.sys.properties.writeWithoutResponse))throw new Error('ช่องค่าตั้งค่าของเซนเซอร์เขียนไม่ได้');
    const read=sysBytes(await rd(ch.sys)),why=oriPreflight(read);
    if(why.length)throw new Error('ไม่ได้เขียน: '+why.join(' · '));
    const dv=new DataView(read.buffer),old=dv.getUint32(56,true),om=oriMap();
    const oldAx={x:om[(old>>8)&15]||'?',y:om[(old>>4)&15]||'?',z:om[old&15]||'?'};
    if(['x','y','z'].every(k=>oldAx[k]===axes[k])){toast('ในเซนเซอร์ตั้งไว้แบบนี้อยู่แล้ว');ok=true;return true}
    const out=buildOriWrite(read,codes,Math.floor(Date.now()/1000)),changed=diffBytes(read,out);
    if(changed.some(i=>!ORI_BYTES(i)))throw new Error('ตรวจพบไบต์ที่ไม่ควรเปลี่ยน ยกเลิกการเขียน');
    ble.busy=false; // the dialog below waits for the user
    const msg=`เขียนทิศแกนลงเซนเซอร์?\n\n${['x','y','z'].map(k=>`${k.toUpperCase()}: ${AXN[oldAx[k]]||oldAx[k]} → ${AXN[axes[k]]}`).join('\n')}\n\n• เปลี่ยนเฉพาะค่าทิศ 3 แกน และเวลาที่แก้ค่า (แบบเดียวกับแอป i-ALERT)\n• ค่าอื่นทุกไบต์ (เกณฑ์ alarm, ช่วงเวลาวัด ฯลฯ) เขียนกลับเหมือนที่อ่านมา\n• อ่านกลับมาตรวจหลังเขียน\n\nกด OK เพื่อเขียน`;
    if(!confirm(msg)){bleLog('ยกเลิกการเขียนทิศแกน');return false}
    ble.busy=true;
    const fresh=sysBytes(await rd(ch.sys)); // re-read: nothing may have changed while the dialog was open
    if(diffBytes(read,fresh,CONFIG_RANGES).length)throw new Error('ค่าตั้งค่าในเซนเซอร์เปลี่ยนระหว่างรอยืนยัน ยกเลิกการเขียน ลองใหม่อีกครั้ง');
    const why2=oriPreflight(fresh);if(why2.length)throw new Error('ไม่ได้เขียน: '+why2.join(' · '));
    const out2=buildOriWrite(fresh,codes,Math.floor(Date.now()/1000)),ch2=diffBytes(fresh,out2);
    if(ch2.some(i=>!ORI_BYTES(i)))throw new Error('ตรวจพบไบต์ที่ไม่ควรเปลี่ยน ยกเลิกการเขียน');
    bleLog('เขียนทิศแกนลงเซนเซอร์: '+ch2.map(i=>`ไบต์ ${i} ${hex2(fresh[i])}→${hex2(out2[i])}`).join(', ')+' (ไบต์อื่นคงเดิม)');
    S.lastOriWrite=Date.now();save();
    if(ch.sys.properties.write)await ch.sys.writeValueWithResponse(out2);else await ch.sys.writeValueWithoutResponse(out2);
    await sleep(1500);
    const back=sysBytes(await rd(ch.sys)),bset=new DataView(back.buffer).getUint32(56,true);
    const got={x:(bset>>8)&15,y:(bset>>4)&15,z:bset&15},cfgDiff=diffBytes(fresh,back,CONFIG_RANGES).filter(i=>!(i>=56&&i<=59));
    if(got.x!==codes.x||got.y!==codes.y||got.z!==codes.z)throw new Error(`อ่านกลับแล้วทิศแกนไม่ตรง (ได้ ${got.x}/${got.y}/${got.z}) กรุณาตรวจในแอป i-ALERT`);
    if(cfgDiff.length){const m='⚠ ค่าตั้งค่าอื่นต่างจากก่อนเขียนที่ไบต์ '+cfgDiff.map(i=>`${i} (${hex2(fresh[i])}→${hex2(back[i])})`).join(', ');bleLog(m);alert(m+'\n\nกรุณาตรวจค่าในแอป i-ALERT')}
    else bleLog('ตรวจซ้ำแล้ว: ทิศแกนตรงตามที่เขียน ค่าตั้งค่าอื่นไม่เปลี่ยน ✓');
    applySys(parseSys(new DataView(back.buffer),ble.cfg.scale));
    if(typeof appLog==='function')appLog('set',`เขียนทิศแกนลงเซนเซอร์ ${sensorLabel(dev.id)}: ${axTxt(axes)}`);
    toast('เขียนทิศแกนลงเซนเซอร์แล้ว และอ่านกลับตรวจถูกต้อง');ok=true;
  }catch(e){err=e;bleLog('เขียนทิศแกนไม่สำเร็จ: '+e.message);toast(e.message)}
  finally{ble.busy=false;if(!ble.liveTimer&&!SP.timer)try{if(dev.gatt.connected)dev.gatt.disconnect()}catch(e){}bleFinish(dev,err);fillLive()}
  return ok;
}

// ---------- tap test: tap the machine in one direction, the axis that rises most shows which way it points ----------
async function openTapTest(a){
  const c=cfg(a),ax=sensorAxesOf(c,a);
  infoDialog('ทดสอบเคาะ · '+esc(pointLabel(a)),`<ol style="margin:0 0 8px;padding-left:18px;font-size:13.5px">
    <li>เชื่อมต่อเซนเซอร์ที่ติดจุดนี้ (หรือเซนเซอร์พกพาที่วางอยู่)</li><li>กด "อ่านค่าก่อนเคาะ" ตอนเครื่องนิ่งหรือเดินปกติ</li>
    <li>เคาะเสื้อลูกปืนต่อเนื่องในทิศเดียว เช่น เคาะจากด้านบนลงล่าง (แนวตั้ง) จนเซนเซอร์อัปเดตค่า แล้วกด "อ่านค่าระหว่างเคาะ"</li></ol>
    <div class="row"><select id="ttDir"><option value="V">เคาะแนวตั้ง</option><option value="H">เคาะแนวนอน</option><option value="A">เคาะแนวแกนเพลา</option></select>
    <button class="btn sm" id="ttB">อ่านค่าก่อนเคาะ</button><button class="btn sm" id="ttA">อ่านค่าระหว่างเคาะ</button></div>
    <div id="ttOut" class="ms-box" style="margin-top:8px;font-size:13px">ทิศที่ตั้งไว้ตอนนี้: ${axTxt(ax)}</div>`);
  const d=$('#infoDlg');let before=null;
  const readG=async()=>{if(!ble.device)return toast('เชื่อมต่อเซนเซอร์ก่อน'),null;const s=isPortable(ble.device.id)?await spotReadOnce():(await bleLiveRead(),ble.live&&ble.live.sys);return s?s.checkG.slice():null};
  d.querySelector('#ttB').onclick=async()=>{before=await readG();if(before)d.querySelector('#ttOut').textContent='ก่อนเคาะ (g): '+before.map(v=>fn(v,3)).join(' / ')};
  d.querySelector('#ttA').onclick=async()=>{if(!before)return toast('อ่านค่าก่อนเคาะก่อน');const after=await readG();if(!after)return;
    const r=dominantAxis(before,after),dir=d.querySelector('#ttDir').value,k=r.axis==null?null:['x','y','z'][r.axis];
    d.querySelector('#ttOut').innerHTML=r.axis==null?'ค่าไม่เปลี่ยน ลองเคาะแรงขึ้น หรือรอให้เซนเซอร์อัปเดตค่าก่อนกด (ทุก '+((ble.live&&ble.live.sys.wakeSec)||'?')+' วินาที)'
      :`แกนที่ตอบสนองมากสุด: <b>${k.toUpperCase()}</b> (มากกว่าแกนอื่น ${r.ratio===Infinity?'มาก':r.ratio+' เท่า'}) ${!r.clear?'· <span class="up">ยังไม่ชัด ลองใหม่</span>':ax[k]===dir?'· ✓ ตรงกับที่ตั้งไว้':`· <span class="up">ที่ตั้งไว้คือ ${AXN[ax[k]]} ไม่ตรงกับทิศที่เคาะ (${AXN[dir]})</span>`}`;
    if(r.clear&&ax[k]===dir){specOf(c).axesOk=true;save()}};
}
