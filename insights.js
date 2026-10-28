// Analysis on the stored trends (all read-only): running/stopped, data gaps, forecast, baseline,
// alerts, sensor health and the optional FFT schedule check. Loaded before the dashboard script;
// uses its globals at call time (S, DAY, cfg, series, overall, accMax, status, useSensorThr,
// tempLimits, clockOk, ble, bleLog, toast, fv, uv, dFull, save, render, setView, scan).

// ---- running / stopped ----
const RUN_MIN_DEFAULT=0.3; // mm/s overall; below = machine stopped
const runMin=c=>c&&c.runMin!=null?c.runMin:RUN_MIN_DEFAULT;
function isRunning(r,c){
  if(r.run!=null)return r.run;
  const v=overall(r);return v==null?null:v>=runMin(c);
}
function medianStep(rs){
  if(rs.length<3)return 36e5;
  const d=[];for(let i=1;i<rs.length;i++){const x=rs[i].t-rs[i-1].t;if(x>0)d.push(x)}
  d.sort((a,b)=>a-b);return d[Math.floor(d.length/2)]||36e5;
}
// Stopped intervals [from,to] and running hours / starts over a window
function runInfo(rs,c,from=-Infinity){
  const xs=rs.filter(r=>r.t>=from),step=medianStep(xs),cap=step*2.5,stops=[];
  let runMs=0,starts=0,prev=null,stopFrom=null;
  for(const r of xs){
    const on=isRunning(r,c);
    if(prev){const dt=Math.min(r.t-prev.t,cap);if(on&&isRunning(prev,c))runMs+=dt;if(on&&isRunning(prev,c)===false)starts++}
    if(on===false&&stopFrom==null)stopFrom=r.t;
    if(on!==false&&stopFrom!=null){stops.push([stopFrom,r.t]);stopFrom=null}
    prev=r;
  }
  if(stopFrom!=null)stops.push([stopFrom,xs.at(-1).t]);
  return{runH:runMs/36e5,starts,stops,step};
}

// ---- data gaps ----
function sensorKeysOf(asset){return Object.entries(S.sensors||{}).filter(([id,v])=>v.asset===asset&&!(typeof isPortable==='function'&&isPortable(id))).map(([id,v])=>v.mac||id)}
function findGaps(rs,asset,c){
  if(rs.length<3)return[];
  const step=medianStep(rs),thr=Math.max(3*step,2*36e5),out=[];
  const resets=sensorKeysOf(asset).flatMap(k=>(S.health[k]||[]).filter(h=>h.reset).map(h=>h.t));
  for(let i=1;i<rs.length;i++){
    const a=rs[i-1],b=rs[i],dur=b.t-a.t;if(dur<=thr)continue;
    let cause='ไม่มีข้อมูล (เซนเซอร์ไม่ได้บันทึก หรือไม่ได้ดึงข้อมูลช่วงนี้)';
    if(resets.some(t=>t>=a.t&&t<=b.t+DAY))cause='นาฬิกาเซนเซอร์รีเซ็ต (เซนเซอร์รีสตาร์ท) ค่าช่วงนี้มีเวลาผิดจึงถูกข้าม';
    else if(isRunning(a,c)===false&&isRunning(b,c)===false)cause='เครื่องหยุด (ค่าก่อนและหลังช่วงนี้ต่ำ)';
    out.push({from:a.t,to:b.t,dur,cause});
  }
  return out;
}
const fmtSpan=ms=>{const h=ms/36e5;return h>=48?`${(h/24).toFixed(1)} วัน`:`${h.toFixed(1)} ชม.`};

// ---- forecast (#6) ----
// Daily means of running readings, then a straight line and an exponential curve; the better fit
// (R² in the original units) is used. No answer unless the data supports one.
function effLimits(c,key){
  const tl=tempLimits(c);
  if(key==='temp')return{warn:tl.tw,alarm:tl.ta};
  if(key==='acc')return{warn:null,alarm:null};
  const ax={vx:0,vy:1,vz:2}[key];
  let warn,alarm;
  if(useSensorThr(c)){const lo=a=>{const v=a.filter(x=>x!=null);return v.length?Math.min(...v):null};
    warn=ax!=null?c.sensorThr.warn[ax]:lo(c.sensorThr.warn);alarm=ax!=null?c.sensorThr.alarm[ax]:lo(c.sensorThr.alarm)}
  else{warn=c.z[1];alarm=c.z[2]}
  const bl=baselineLimits(c,ax);
  if(bl){if(warn==null||bl.warn<warn)warn=bl.warn;if(alarm==null||bl.alarm<alarm)alarm=bl.alarm}
  return{warn,alarm};
}
const FC_KEYS={ov:['Velocity รวม',r=>overall(r)],vx:['Velocity X',r=>r.vx],vy:['Velocity Y',r=>r.vy],vz:['Velocity Z',r=>r.vz],acc:['Acceleration สูงสุด',r=>accMax(r)],temp:['อุณหภูมิ',r=>r.temp]};
function forecast(rs,c,key='ov',days){
  days=days||S.fcDays||30;
  if(!rs.length)return{ok:false,why:'ไม่มีข้อมูล'};
  const get=FC_KEYS[key][1],end=rs.at(-1).t,from=end-days*DAY;
  const byDay=new Map();
  for(const r of rs){if(r.t<from||isRunning(r,c)===false)continue;const v=get(r);if(v==null||!(v>0))continue;
    const d=Math.floor(r.t/DAY);const e=byDay.get(d)||{s:0,n:0};e.s+=v;e.n++;byDay.set(d,e)}
  const pts=[...byDay.entries()].map(([d,e])=>({x:(d*DAY+DAY/2-end)/DAY,y:e.s/e.n}));
  if(pts.length<5)return{ok:false,why:`ข้อมูลตอนเครื่องเดินมี ${pts.length} วัน (ต้องมีอย่างน้อย 5 วัน)`};
  const fit=(xs,ys)=>{const n=xs.length,mx=xs.reduce((a,b)=>a+b)/n,my=ys.reduce((a,b)=>a+b)/n;
    let sxy=0,sxx=0;for(let i=0;i<n;i++){sxy+=(xs[i]-mx)*(ys[i]-my);sxx+=(xs[i]-mx)**2}
    const b=sxx?sxy/sxx:0;return{a:my-b*mx,b}};
  const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y),my=ys.reduce((a,b)=>a+b)/ys.length;
  const r2=f=>{let ss=0,st=0;pts.forEach(p=>{ss+=(p.y-f(p.x))**2;st+=(p.y-my)**2});return st?1-ss/st:0};
  const L=fit(xs,ys),E=fit(xs,ys.map(Math.log));
  const fl=x=>L.a+L.b*x,fe=x=>Math.exp(E.a+E.b*x);
  const rl=r2(fl),re=r2(fe);
  const m=re>rl+0.02?{kind:'exp',f:fe,r2:re,inv:y=>(Math.log(y)-E.a)/E.b,up:E.b>0}:{kind:'lin',f:fl,r2:rl,inv:y=>(y-L.a)/L.b,up:L.b>0};
  const res={ok:true,...m,days:pts.length,pts,now:m.f(0),perWeek:m.f(7)-m.f(0),end};
  const lim=effLimits(c,key==='ov'?'ov':key);res.lim=lim;
  if(m.r2<0.3){res.ok=false;res.why=`ค่าแกว่งมาก หาแนวโน้มที่เชื่อถือได้ไม่ได้ (R² = ${m.r2.toFixed(2)})`;return res}
  const cross=lv=>{if(lv==null)return null;if(res.now>=lv)return 0;if(!m.up)return null;const d=m.inv(lv);return d>0?d:null};
  // days are counted from the last reading; shown dates are from today, so take off the data's age
  const age=Math.max(0,(Date.now()-end)/DAY),fromNow=d=>d==null?null:Math.max(0,d-age);
  res.dWarn=fromNow(cross(lim.warn));res.dAlarm=fromNow(cross(lim.alarm));res.age=age;
  return res;
}
const fmtDays=d=>d==null?null:d===0?'เกินแล้ว':d>365?'มากกว่า 1 ปี':`อีก ~${Math.round(d)} วัน (${new Date(Date.now()+d*DAY).toLocaleDateString('th-TH',{day:'numeric',month:'short'})})`;

// ---- baseline (#9): stored in the page only, never written to the sensor ----
function computeBaseline(asset,from,to){
  const c=cfg(asset),rs=series(asset).filter(r=>r.t>=from&&r.t<=to&&isRunning(r,c)!==false);
  if(rs.length<10)return null;
  const stat=k=>{const v=rs.map(r=>r[k]).filter(x=>x!=null);if(!v.length)return[null,null];
    const m=v.reduce((a,b)=>a+b)/v.length,sd=Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/v.length);return[m,sd]};
  const s=['vx','vy','vz'].map(stat);
  return{from,to,n:rs.length,mean:s.map(x=>x[0]),sd:s.map(x=>x[1]),mul:(c.baseline&&c.baseline.mul)||[2,4]};
}
function baselineLimits(c,ax){
  const b=c&&c.useBaseline&&c.baseline;if(!b)return null;
  const lim=i=>b.mean[i]==null?null:{warn:Math.max(b.mean[i]*b.mul[0],b.mean[i]+3*b.sd[i]),alarm:Math.max(b.mean[i]*b.mul[1],b.mean[i]+6*b.sd[i])};
  if(ax!=null)return lim(ax);
  const all=[0,1,2].map(lim).filter(Boolean);if(!all.length)return null;
  return{warn:Math.min(...all.map(l=>l.warn)),alarm:Math.min(...all.map(l=>l.alarm))};
}
function baselineZone(axes,c){
  if(!c||!c.useBaseline||!c.baseline)return null;let z=null;
  axes.forEach((v,i)=>{const l=v!=null&&baselineLimits(c,i);if(!l)return;
    if(v>=l.alarm)z='D';else if(v>=l.warn&&z!=='D')z='C'});
  return z;
}
function baselineDelta(r,c){
  const b=c.baseline;if(!b)return null;
  const m=Math.max(...b.mean.filter(x=>x!=null)),v=overall(r);
  return m>0&&v!=null?(v-m)/m*100:null;
}

// ---- notifications (#7) ----
let audioCtx=null;
function beep(){
  try{audioCtx=audioCtx||new AudioContext();const o=audioCtx.createOscillator(),g=audioCtx.createGain();
    o.frequency.value=880;g.gain.setValueAtTime(.2,audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+.6);
    o.connect(g).connect(audioCtx.destination);o.start();o.stop(audioCtx.currentTime+.6)}catch(e){}
}
async function notify(key,title,body,asset){
  S.notified=S.notified||{};
  const gap=(S.notify&&S.notify.gapH||6)*36e5;
  if(Date.now()-(S.notified[key]||0)<gap)return;
  S.notified[key]=Date.now();save();
  toast(title+' — '+body);bleLog('แจ้งเตือน: '+title+' — '+body);
  if(asset&&typeof quietNow==='function'&&quietNow(S.assets[asset])){appLog('sys','ช่วงไม่แจ้งเตือนของ '+asset+': ไม่ส่งการแจ้งเตือน');return}
  if(!S.notify||!S.notify.on)return;
  if(S.notify.sound!==false)beep();
  if(!('Notification' in window)||Notification.permission!=='granted')return;
  const opt={body,tag:key,icon:'icon-192.png',badge:'icon-192.png',data:{asset}};
  try{const reg=navigator.serviceWorker&&await navigator.serviceWorker.getRegistration();
    if(reg)await reg.showNotification(title,opt);else new Notification(title,opt)}catch(e){console.warn(e)}
}
async function enableNotifications(on){
  S.notify=Object.assign({sound:true,wake:true,gapH:6},S.notify||{},{on});
  if(on&&'Notification' in window&&Notification.permission==='default'){
    const p=await Notification.requestPermission();
    if(p!=='granted')toast('เบราว์เซอร์ไม่อนุญาตการแจ้งเตือน จะแจ้งเป็นข้อความในหน้าเว็บแทน');
  }
  save();updateWakeLock();
}
function checkAlerts(asset,recs){
  const c=cfg(asset),last=recs.slice().sort((a,b)=>a.t-b.t).at(-1);if(!last)return;
  const al=(c.spec&&c.spec.alarm)||{};if(al.notify===false)return; // switched off for this machine
  {const cr=String((c.spec&&c.spec.turbine&&c.spec.turbine.critRpm)||'').match(/(\d+)\s*[-–]\s*(\d+)/);
    if(cr&&last.rpm&&last.rpm>=+cr[1]&&last.rpm<=+cr[2])notify(asset+'|crit','⚠ เทอร์ไบน์เดินในช่วงรอบวิกฤต: '+asset,`${last.rpm} RPM อยู่ในช่วง ${cr[1]}–${cr[2]} RPM ไม่ควรเดินค้างในช่วงนี้`,asset)}
  const z=status(last,c);
  // only after N readings in a row are in C/D (N from the rule or the machine's criticality), so one spike does not alarm
  // a spot check is one reading days apart: two in a row confirm it (the first asks for a re-measurement)
  const n=last.src==='spot'?2:typeof alarmPersist==='function'?alarmPersist(c):1,lastN=series(asset).filter(r=>!r.live).slice(-n);
  const held=lastN.length>=n&&lastN.every(r=>{const s=status(r,c);return s==='C'||s==='D'});
  if(al.risePct>0){const ov=overall(last);let ref=null;
    if(al.riseRef==='baseline'&&c.baseline)ref=vmax(c.baseline.mean.filter(x=>x!=null));
    else{const w=series(asset).filter(r=>r.t<last.t-864e5&&r.t>=last.t-8*864e5&&isRunning(r,c)!==false).map(overall).filter(v=>v!=null);if(w.length)ref=w.reduce((a,b)=>a+b,0)/w.length}
    if(ref>0&&ov>ref*(1+al.risePct/100))notify(asset+'|rise','📈 เพิ่มขึ้นเร็ว: '+asset,`${fv(ov)} ${uv()} สูงกว่า${al.riseRef==='baseline'?' baseline':'ค่าเฉลี่ย 7 วัน'} ${Math.round((ov/ref-1)*100)}% (เกณฑ์ ${al.risePct}%)`,asset)}
  const mpts=typeof pointsOf==='function'?pointsOf(machineOf(asset)):[];
  if((z==='C'||z==='D')&&held&&mpts.length>1){const m=machineOf(asset);
    notify(m+'|'+z,`${z==='D'?'⛔ อันตราย':'⚠ เฝ้าระวัง'}: ${m} · ${pointLabel(asset)}`,mpts.map(p=>{const r=lastOf(p),s=status(r,cfg(p));return`${pointLabel(p)}: ${s?ZL[s]:'–'} ${fv(overall(r))}`}).join(' · ')+` ${uv()}`,asset)}
  else if((z==='C'||z==='D')&&held)notify(asset+'|'+z,`${z==='D'?'⛔ อันตราย':'⚠ เฝ้าระวัง'}: ${asset}`,
    `Velocity ${fv(overall(last))} ${uv()} · อุณหภูมิ ${last.temp!=null?last.temp.toFixed(1)+' °C':'–'} (${dFull(last.t)})`,asset);
  const f=forecast(series(asset),c,'ov');
  if(f.ok&&f.dAlarm!=null&&f.dAlarm>0&&f.dAlarm<14)notify(asset+'|fc','📈 แนวโน้มเพิ่มขึ้น: '+asset,`คาดว่าจะถึงระดับอันตราย${fmtDays(f.dAlarm)}`,asset);
}
function noteFetchFailure(asset){
  if(!asset){ble.failCount=0;return}
  ble.failCount=(ble.failCount||0)+1;
  if(ble.failCount===3)notify('fail|'+asset,'ดึงข้อมูลไม่สำเร็จ 3 ครั้งติด',`${asset}: ตรวจว่าเซนเซอร์อยู่ในระยะ และปิดแอป i-ALERT บนมือถือแล้ว`,asset);
}
// Keep a tablet's screen on while auto-fetch runs (it stops when the screen sleeps)
let wakeLock=null;
async function updateWakeLock(){
  const want=!!(ble.timer&&S.notify&&S.notify.wake!==false&&document.visibilityState==='visible');
  try{
    if(want&&!wakeLock&&navigator.wakeLock){wakeLock=await navigator.wakeLock.request('screen');wakeLock.addEventListener('release',()=>{wakeLock=null})}
    else if(!want&&wakeLock){await wakeLock.release();wakeLock=null}
  }catch(e){}
}
document.addEventListener('visibilitychange',updateWakeLock);
setInterval(updateWakeLock,20000);

// ---- sensor health (#10) ----
function recordHealth(dev,s,res){
  const sv=S.sensors[dev.id]||{},key=(s&&s.mac)||sv.mac||dev.id,list=S.health[key]||(S.health[key]=[]);
  const row=scan.rows.get(dev.id);
  const h={t:Date.now(),ok:res.ok,att:res.attempts,ms:res.ms,rssi:row&&row.rssi!=null?row.rssi:null,temp:s&&s.rec&&s.rec.temp!=null?s.rec.temp:null};
  if(s)Object.assign(h,{batt:s.battV,drift:Math.round(s.clock-Date.now()/1000),reset:!clockOk(s)||!!s.wasReset,clockBad:!clockOk(s),fixed:!!s.wasReset&&clockOk(s),batLow:s.flags.battery,
    rev:s.rev,devType:s.devType,trendSec:s.trendSec,wakeSec:s.wakeSec,runH:Math.round(s.runH)});
  list.push(h);if(list.length>3000)list.splice(0,list.length-3000);
  save();
  const asset=sv.asset||(ble.cfg&&ble.cfg.asset)||'';
  if(s&&s.flags.battery)notify('bat|'+key,'🔋 แบตเซนเซอร์ต่ำ',`${asset}: เตรียมเปลี่ยนแบตเตอรี่`,asset);
  if(s&&!clockOk(s))notify('clk|'+key,'⏱ นาฬิกาเซนเซอร์ไม่ตรง',`${asset}: ${timeSyncNeeded(s)?'ตั้งเวลาอัตโนมัติไม่สำเร็จ กด "ตั้งเวลาเซนเซอร์" หรือใช้แอป i-ALERT':'เซนเซอร์แจ้งว่าตั้งเวลาแล้วแต่เวลาไม่ตรง ให้ใช้แอป i-ALERT'}`,asset);
  else if(s&&s.wasReset)notify('clkfix|'+key,'⏱ เซนเซอร์รีสตาร์ท — ตั้งเวลาให้แล้ว',`${asset}: ถ้าเกิดบ่อยให้ตรวจแบตเตอรี่${s.battV?' ('+s.battV.toFixed(2)+' V)':''}`,asset);
}
// Battery bars as the i-ALERT app computes them from voltage (SensorIAlertBatteryCalculation):
// cut-offs 3.02 / 2.93 / 2.74 V plus 0.0049 V per °C of sensor temperature; 1 bar = battery alarm
const battCut=T=>[2.74,2.93,3.02].map(b=>b+0.0049*(T==null?25:T));
function batteryBars(v,T){if(!(v>0))return null;const c=battCut(T);return v>c[2]?4:v>c[1]?3:v>c[0]?2:1}
const BATT_EMPTY=2.74+0.0049*25; // V, the app's 1-bar cut-off at 25 °C
// Battery %: 0 % at the app's 1-bar cut-off (replace), 100 % at a fresh cell (3.30 V under load at 25 °C),
// both shifted 0.0049 V/°C like the app. Lithium cells hold their voltage until late, so this is a rough
// guide that drops faster near the end; the forecast is redone at every connection.
const BATT_FULL=3.30;
function battPct(v,T){if(!(v>0))return null;const d=0.0049*(T==null?25:T),e=2.74+d,f=BATT_FULL+d;return Math.max(0,Math.min(100,(v-e)/(f-e)*100))}
// Straight line through daily averages of the last 90 days → date the % reaches 0
function battForecast(pts){
  const from=Date.now()-90*DAY,byDay=new Map();
  for(const p of pts){if(p.t<from||p.pct==null)continue;const d=Math.floor(p.t/DAY),e=byDay.get(d)||{s:0,n:0};e.s+=p.pct;e.n++;byDay.set(d,e)}
  const xs=[...byDay.entries()].map(([d,e])=>({x:d+0.5,y:e.s/e.n})).sort((a,b)=>a.x-b.x);
  const now=pts.length?pts.at(-1).pct:null;
  if(xs.length<3||xs.at(-1).x-xs[0].x<7)return{ok:false,now,why:`ต้องมีข้อมูลแบตอย่างน้อย 3 วันที่ต่างกัน ครอบคลุม 7 วันขึ้นไป (ตอนนี้มี ${xs.length} วัน)`};
  const n=xs.length,mx=xs.reduce((a,p)=>a+p.x,0)/n,my=xs.reduce((a,p)=>a+p.y,0)/n;let sxy=0,sxx=0,st=0,ss=0;
  xs.forEach(p=>{sxy+=(p.x-mx)*(p.y-my);sxx+=(p.x-mx)**2});const b=sxx?sxy/sxx:0,a=my-b*mx;
  xs.forEach(p=>{st+=(p.y-my)**2;ss+=(p.y-(a+b*p.x))**2});const r2=st?1-ss/st:0;
  const today=Date.now()/DAY,fit=a+b*today;
  if(b>=-0.005)return{ok:false,now,a,b,r2,why:'ยังไม่เห็นแบตลดลงชัดเจนในช่วงที่มีข้อมูล'};
  const zero=-a/b,days=Math.max(0,zero-today);
  return{ok:true,now,a,b,r2,perMonth:b*30,days,date:zero*DAY,fit};
}
function healthSummary(id){
  const sv=S.sensors[id]||{},key=sv.mac||id,H=(S.health[key]||[]).slice(),last=H.filter(h=>h.batt!=null).at(-1);
  const out={key,n:H.length,last,issues:[],score:'ok'};
  if(!H.length){out.score='none';return out}
  // battery % history and the date it reaches "replace" (0 % = the app's 1-bar cut-off)
  const tr=sv.asset?series(sv.asset).filter(r=>r.temp!=null):[]; // sorted by time
  const tempAt=t=>{if(!tr.length)return null;let lo=0,hi=tr.length-1;while(hi-lo>1){const m=(lo+hi)>>1;if(tr[m].t<t)lo=m;else hi=m}return(Math.abs(tr[lo].t-t)<Math.abs(tr[hi].t-t)?tr[lo]:tr[hi]).temp};
  out.bpts=H.filter(h=>h.batt>0).map(h=>{const T=h.temp!=null?h.temp:tempAt(h.t);return{t:h.t,v:h.batt,T,pct:battPct(h.batt,T)}});
  out.bfc=battForecast(out.bpts);
  if(out.bfc&&out.bfc.ok)out.battMonths=out.bfc.days/30;
  out.resets=H.filter((h,i)=>h.reset&&!(H[i-1]&&H[i-1].reset));
  const okd=H.filter(h=>h.ok);
  out.firstTry=okd.length?okd.filter(h=>h.att===1).length/okd.length:null;
  out.successRate=H.length?okd.length/H.length:null;
  const rs=H.filter(h=>h.rssi!=null);out.rssi=rs.length?Math.round(rs.slice(-20).reduce((a,h)=>a+h.rssi,0)/Math.min(20,rs.length)):null;
  // completeness: trends received in the last 30 days vs. expected from the trend interval
  if(last&&last.trendSec&&sv.asset){
    const from=Date.now()-30*DAY,got=series(sv.asset).filter(r=>!r.live&&r.t>=from).length;
    const first=series(sv.asset).find(r=>!r.live);const span=Math.min(30*DAY,Date.now()-(first?first.t:Date.now()));
    out.complete=span>DAY?Math.min(1,got/(span/1000/last.trendSec)):null;
  }
  const tNow=sv.asset&&series(sv.asset).filter(r=>r.temp!=null).at(-1);out.battT=tNow?tNow.temp:null;out.bars=last?batteryBars(last.batt,out.battT):null;out.cut=battCut(out.battT);
  if(last&&last.batLow)out.issues.push(['bad','เซนเซอร์แจ้งแบตเตอรี่ต่ำ ควรเปลี่ยนแบต']);
  else if(out.bars===1)out.issues.push(['bad',`แบต ${last.batt.toFixed(2)} V = 1 ขีดจาก 4 (เกณฑ์แบบแอป i-ALERT ที่ ${out.battT!=null?out.battT.toFixed(0):25} °C) ควรเปลี่ยนแบต`]);
  else if(out.bars===2)out.issues.push(['warn',`แบต ${last.batt.toFixed(2)} V = 2 ขีดจาก 4 ควรเตรียมแบตสำรอง`]);
  else if(out.bfc&&out.bfc.ok&&out.bfc.days<90)out.issues.push(['warn',`คาดว่าต้องเปลี่ยนแบตประมาณ ${new Date(out.bfc.date).toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'numeric'})} (อีก ~${Math.round(out.bfc.days)} วัน)`]);
  // clockBad = still wrong after connecting; older records only have reset (= clock was wrong when read)
  const hb=H.filter(h=>h.batt!=null||h.drift!=null).at(-1),clockBad=hb&&(hb.clockBad!=null?hb.clockBad:hb.drift!=null?Math.abs(hb.drift)>86400:hb.reset);out.clockBad=!!clockBad;
  if(clockBad)out.issues.push(['bad','นาฬิกาเซนเซอร์ยังไม่ตรง — เชื่อมต่อเซนเซอร์อีกครั้ง ระบบจะตั้งเวลาให้อัตโนมัติ (หรือกด "ตั้งเวลาเซนเซอร์")']);
  else if(last&&Math.abs(last.drift)>600)out.issues.push(['warn',`นาฬิกาเซนเซอร์คลาดเคลื่อน ${Math.round(Math.abs(last.drift)/60)} นาที`]);
  if(out.resets.length)out.issues.push(['warn',`เซนเซอร์รีสตาร์ท/นาฬิการีเซ็ต ${out.resets.length} ครั้ง (ล่าสุด ${dFull(out.resets.at(-1).t)})`]);
  if(out.complete!=null&&out.complete<0.8)out.issues.push(['warn',`ได้ข้อมูล ${Math.round(out.complete*100)}% ของที่ควรได้ใน 30 วัน`]);
  if(out.firstTry!=null&&out.firstTry<0.6)out.issues.push(['warn','เชื่อมต่อครั้งแรกมักไม่สำเร็จ ลองวางเครื่องให้ใกล้เซนเซอร์ขึ้น']);
  if(out.rssi!=null&&out.rssi<-85)out.issues.push(['warn',`สัญญาณอ่อน (${out.rssi} dBm)`]);
  out.score=out.issues.some(i=>i[0]==='bad')?'bad':out.issues.length?'warn':'ok';
  return out;
}

// ---- FFT schedule check (#20): only answers "is a scheduled measurement due now?" ----
// The measurement itself is bleMeasureFFT({auto:true}) with every safety check of the manual button.
const SCHED_MS={day:864e5,week:7*864e5},SCHED_MAX_PER_DAY=2;
async function scheduledMeasureDue(dev,s){
  const sv=S.sensors[dev.id];if(!sv||!((sv.sched&&sv.sched.on)||(sv.cond&&sv.cond.on)))return false;
  if(typeof isPortable==='function'&&isPortable(dev.id))return false;
  const log=sv.schedLog||[],now=Date.now();
  if((sv.schedFail||0)>=3){bleLog('FFT ตามตาราง: หยุดชั่วคราวเพราะสั่งวัดไม่สำเร็จ 3 ครั้งติด (เปิดใหม่ได้ในหน้าเซนเซอร์)');return false}
  // conditional (B6): measure now when the newest reading is in warning/alarm, at most every 12 h
  const c0=cfg(sv.asset),z0=s.rec?status(s.rec,c0):null,condDue=sv.cond&&sv.cond.on&&(z0==='C'||z0==='D')&&now-(sv.condLast||0)>=12*36e5;
  if(condDue){if(log.filter(t=>now-t<DAY).length>=SCHED_MAX_PER_DAY)return false;if(s.flags.battery||!clockOk(s)||!s.flags.running)return false;
    if(now-(S.lastMeasure||0)<MEASURE_GAP_MS)return false;sv.condLast=now;save();bleLog(`FFT ตามเงื่อนไข: ค่าล่าสุดอยู่ระดับ${z0==='D'?'อันตราย':'เฝ้าระวัง'} สั่งวัด FFT เพื่อเก็บหลักฐาน`);return true}
  if(!sv.sched||!sv.sched.on)return false;
  if(log.length&&now-Math.max(...log)<(SCHED_MS[sv.sched.per]||DAY))return false;
  if(log.filter(t=>now-t<DAY).length>=SCHED_MAX_PER_DAY)return false;
  if(s.flags.battery){bleLog('FFT ตามตาราง: ข้าม เพราะแบตเซนเซอร์ต่ำ');return false}
  if(!clockOk(s)){bleLog('FFT ตามตาราง: ข้าม เพราะนาฬิกาเซนเซอร์ไม่ตรง');return false}
  const c=cfg(sv.asset),r=s.rec;
  if(!s.flags.running||(r&&isRunning(r,c)===false)){bleLog('FFT ตามตาราง: ข้าม เพราะเครื่องหยุดอยู่ (จะลองใหม่รอบถัดไป)');return false}
  if(now-(S.lastMeasure||0)<MEASURE_GAP_MS)return false;
  return true;
}

// ---- chart overlays: stopped periods, gaps, maintenance markers ----
const tBands={id:'tBands',
  beforeDatasetsDraw(chart,args,o){
    const B=o&&o.bands;if(!B||!B.length)return;
    const{ctx,chartArea:a,scales:{x}}=chart;ctx.save();
    for(const b of B){const x0=Math.max(a.left,x.getPixelForValue(b.from)),x1=Math.min(a.right,x.getPixelForValue(b.to));
      if(x1<=x0)continue;ctx.globalAlpha=b.alpha??1;if(b.color){ctx.fillStyle=b.color;ctx.fillRect(x0,a.top,x1-x0,a.bottom-a.top)}
      if(b.hatch){ctx.strokeStyle=b.hatch;ctx.lineWidth=1;ctx.beginPath();
        for(let px=x0-(a.bottom-a.top);px<x1;px+=8){ctx.moveTo(Math.max(px,x0),a.bottom-Math.max(0,x0-px));ctx.lineTo(Math.min(px+(a.bottom-a.top),x1),a.top+Math.max(0,px+(a.bottom-a.top)-x1))}
        ctx.stroke()}ctx.globalAlpha=1}
    ctx.restore()},
  afterDatasetsDraw(chart,args,o){
    const L=o&&o.lines;if(!L||!L.length)return;
    const{ctx,chartArea:a,scales:{x}}=chart;ctx.save();ctx.font='11px "IBM Plex Sans Thai",sans-serif';
    for(const l of L){const px=x.getPixelForValue(l.x);if(px<a.left||px>a.right)continue;
      ctx.strokeStyle=l.color;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(px,a.top);ctx.lineTo(px,a.bottom);ctx.stroke();
      ctx.fillStyle=l.color;ctx.beginPath();ctx.arc(px,a.top+5,5,0,7);ctx.fill();
      if(l.label){ctx.fillText(l.label,Math.min(px+7,a.right-ctx.measureText(l.label).width),a.top+9)}}
    ctx.restore()}
};

// ---- app start: service worker (offline + notifications), QR links, notification clicks ----
function initApp(){
  if('serviceWorker' in navigator&&isSecureContext){
    navigator.serviceWorker.register('sw.js').catch(e=>console.warn('SW',e));
    navigator.serviceWorker.addEventListener('message',e=>{if(e.data&&e.data.asset)openAssetLink(e.data.asset)});
  }
  handleHash();window.addEventListener('hashchange',handleHash);
  updateWakeLock();
  // opened from the Raspberry Pi gateway (or one is configured): merge its data quietly
  // (no address set: only ask this page's own server when it is plain http, i.e. the Pi itself; the
  // https site has no /api/status and would just log a 404 on every load)
  if(gwBase()?!(location.protocol==='https:'&&/^http:/.test(gwBase())):location.protocol==='http:')
    gatewayStatus(gwBase()).then(st=>{S._gw=st;if(st&&(!S.gw||S.gw.auto!==false))gatewaySync(true)});
}
// "#asset=<name>" (QR label / notification) opens that machine; connecting still needs a tap
function handleHash(){
  const m=location.hash.match(/asset=([^&]+)/);if(!m)return;
  openAssetLink(decodeURIComponent(m[1]));history.replaceState(null,'',location.pathname+location.search);
}
function openAssetLink(asset){
  if(typeof isSpotPoint==='function'&&isSpotPoint(asset))return openSpot(asset); // QR on a spot-check point: straight to measuring
  S.sel=asset;S.view='overview';save();render();
  const has=Object.values(S.sensors).some(v=>v.asset===asset);
  S._qrAsset=has?asset:null;render();
}
