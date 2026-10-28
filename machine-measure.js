// "Measure the whole machine": one tap measures an FFT on every fixed sensor of a machine.
// Two modes: 'two' = send the measure command to every sensor first (one link at a time), then go round again
// to collect the results, so all points are measured within seconds of each other; 'seq' = one sensor from
// command to download, then the next (slower, does not rely on the sensor measuring on after we disconnect).
// Every write is the single-button measure (triggerMeasure: preflight, byte diff limited to 0-3 and 64-67,
// config re-check), at most one command per sensor per 2 minutes and within the battery budget (fftBudget).
// Results are collected again automatically when only the download failed; a new measure always needs a tap.

const MM={on:false,stop:false,run:null};
const MM_ST={wait:'รอ',trig:'กำลังสั่งวัด',measuring:'สั่งวัดแล้ว',collect:'กำลังดาวน์โหลด',ok:'✓ เสร็จ',old:'⚠ ได้ FFT ชุดเดิม',skip:'ข้าม',fail:'✗ ไม่สำเร็จ'};
const MM_PENDING_MS=30*60000; // a capture left in the sensor is still worth collecting for this long

// ---------- helpers (drafted by worker node autocad08 / gemma-4-e4b, reviewed and corrected) ----------
// FFT measurements of one sensor in the last 24 h / 30 days against the battery budget
function fftBudget(times,now,opts){
  const D=864e5,perDay=opts&&opts.perDay>0?opts.perDay:2,per30=opts&&opts.per30>0?opts.per30:6;
  const v=(Array.isArray(times)?times:[]).filter(t=>typeof t==='number'&&isFinite(t)&&t<=now).sort((a,b)=>a-b);
  const win=v.filter(t=>t>now-D),day=win.length,d30=v.filter(t=>t>now-30*D).length,okDay=day<perDay;
  return{day,d30,okDay,over30:d30>=per30,nextOkAt:okDay?now:win[day-perDay]+D};
}
// rough duration of a machine-wide run, seconds {min,max}
function estimateRunSec(n,mode,withTrend){
  if(!(Number.isInteger(n)&&n>0))return{min:0,max:0};
  const C=[5,30],T=[5,15],M=[10,30],DL=[15,40],TR=withTrend?[10,60]:[0,0],sum=i=>{
    if(mode==='two')return n*(C[i]+T[i])+n*(C[i]+DL[i]+TR[i])+(n===1?M[i]:0);
    return n*(C[i]+T[i]+M[i]+DL[i]+TR[i])};
  return{min:sum(0),max:sum(1)};
}

// ---------- which sensors a machine has ----------
const fixedIds=a=>Object.keys(S.sensors||{}).filter(id=>!id.startsWith('gw:')&&S.sensors[id].asset===a&&!(typeof isPortable==='function'&&isPortable(id)));
const macSibs=id=>{const sv=S.sensors[id]||{};return sv.mac?Object.keys(S.sensors).filter(k=>S.sensors[k].mac===sv.mac):[id]};
// one row per point: ready (this browser may open the sensor), noperm (allowed on another browser only),
// spot (measured with the portable sensor), none (no sensor yet)
function machineSensors(m){
  const pts=[...new Set([...pointsOf(m),...(typeof allPoints==='function'?allPoints().filter(a=>machineOf(a)===m):[])])];
  return pts.map(a=>{
    const ids=fixedIds(a);
    if(!ids.length)return{a,state:typeof isSpotPoint==='function'&&isSpotPoint(a)?'spot':'none'};
    const all=[...new Set(ids.flatMap(macSibs))].filter(id=>!id.startsWith('gw:'));
    const id=all.find(k=>(scan.known&&scan.known.has(k))||(ble.device&&ble.device.id===k));
    const rep=id||ids[0],sv=S.sensors[rep]||{};
    return{a,id:rep,mac:sv.mac||null,state:id?'ready':'noperm'};
  });
}
const mmDev=it=>(scan.known&&scan.known.get(it.id))||(ble.device&&ble.device.id===it.id?ble.device:null);
// running flag (status bit 9) from the last system structure this page read from the sensor
function lastRunning(id){for(const k of macSibs(id)){const r=S.sensors[k]&&S.sensors[k].sysRaw;if(r){try{return!!((dvFromHex(r.hex).getUint16(4,true)>>9)&1)}catch(e){}}}return null}
// MMS-07: what is known before connecting, from the last health record, the budget and the last status
function mmWarn(it){
  const w=[],now=Date.now(),sv=S.sensors[it.id]||{},h=(S.health[sv.mac||it.id]||[]).at(-1),b=fftBudget(fftTimesOf(it.id),now);
  if(!b.okDay)w.push(['day',`สั่งวัดครบ ${b.day} ครั้งใน 24 ชม. แล้ว วัดได้อีก ${dFull(b.nextOkAt)}`]);
  else if(b.over30)w.push(['d30',`30 วันนี้สั่งวัด FFT แล้ว ${b.d30} ครั้ง (ใช้แบตมาก)`]);
  if(h&&h.batLow)w.push(['bat','แบตเซนเซอร์ต่ำ']);
  if(lastRunning(it.id)===false)w.push(['stop','ครั้งล่าสุดเซนเซอร์แจ้งว่าเครื่องหยุด']);
  if(h&&h.clockBad)w.push(['clk','นาฬิกาไม่ตรง จะตั้งเวลาให้ก่อนวัด']);
  const gap=MEASURE_GAP_MS-(now-lastMeasureOf({id:it.id}));if(gap>0)w.push(['gap',`เพิ่งสั่งวัด ต้องรออีก ${Math.ceil(gap/1000)} วินาที`]);
  return w;
}

// ---------- the run ----------
function mmUse(dev,it){watchDisconnect(dev);if(ble.chDev!==dev)ble.ch=null;ble.device=dev;ble.cfg={asset:it.a,scale:(S.sensors[it.id]||{}).scale||816}}
function mmDisc(dev){ble.selfDisc=true;try{if(dev.gatt.connected)dev.gatt.disconnect()}catch(e){}ble.selfDisc=false}
const u8hex=h=>new Uint8Array(dvFromHex(h).buffer);
async function mmFree(){for(let i=0;i<120&&ble.busy;i++)await sleep(500);if(ble.busy)throw new Error('เซนเซอร์ยังทำงานอื่นอยู่')}
async function mmTrigger(it,disc){
  const dev=mmDev(it);if(!dev){it.st='skip';it.msg='เบราว์เซอร์นี้ยังไม่ได้อนุญาตเซนเซอร์นี้';return mmShow()}
  const now=Date.now(),b=fftBudget(fftTimesOf(it.id),now);
  if(!b.okDay){it.st='skip';it.msg=`สั่งวัดครบ ${b.day} ครั้งใน 24 ชม. แล้ว (ถนอมแบต)`;return mmShow()}
  const gap=MEASURE_GAP_MS-(now-lastMeasureOf(dev));if(gap>0){it.st='skip';it.msg=`เพิ่งสั่งวัดไป ต้องรออีก ${Math.ceil(gap/1000)} วินาที`;return mmShow()}
  try{await mmFree()}catch(e){it.st='skip';it.msg=e.message;return mmShow()}
  mmUse(dev,it);it.st='trig';mmShow();
  ble.busy=true;updateBleButton();const t0=Date.now();ble.attempts=0;let s=null,err=null;
  try{
    const ch=await bleConnect(dev,3);
    const trig=await triggerMeasure(dev,ch,{check:x=>{s=x;
      if(x.flags.battery&&!it.allowBat)return'แบตเซนเซอร์ต่ำ (ติ๊ก "รวมตัวที่แบตต่ำ" ถ้าต้องการวัด)';
      if(!x.flags.running&&!MM.run.allowStopped)return'เครื่องหยุดอยู่ (ติ๊ก "วัดแม้เครื่องหยุด" ถ้าต้องการวัด)';return''}});
    it.trig={read:hexOf(trig.read),t0:trig.t0,flag0:trig.flag0,done:trig.done?hexOf(trig.done):null};it.st='measuring';it.msg='';
  }catch(e){err=e;it.msg=e.message;
    if(e.trig){it.trig={read:hexOf(e.trig.read),t0:e.trig.t0,flag0:e.trig.flag0,done:null};it.st='fail'} // written: collect again later
    else it.st=/^ไม่ได้สั่งวัด/.test(e.message)?'skip':'fail'}
  finally{
    ble.busy=false;recordHealth(dev,s,{ok:!err,attempts:ble.attempts,ms:Date.now()-t0});
    if(disc||err)mmDisc(dev);bleFinish(dev,err);save();mmShow();
  }
}
async function mmCollect(it){
  const dev=mmDev(it);if(!dev){it.st='fail';it.msg='เบราว์เซอร์นี้เปิดเซนเซอร์นี้ไม่ได้';return mmShow()}
  try{await mmFree()}catch(e){it.st='fail';it.msg=e.message;return mmShow()}
  mmUse(dev,it);it.st='collect';it.pct=0;mmShow();
  ble.busy=true;updateBleButton();ble.onProgress=p=>{it.pct=p;mmShow()};const t0=Date.now();ble.attempts=0;let err=null;
  try{
    const ch=await bleConnect(dev,3),T=it.trig;
    const r=await collectMeasure(dev,ch,{read:u8hex(T.read),t0:T.t0,flag0:T.flag0,done:T.done?u8hex(T.done):null},{run:MM.run.id});
    it.fftTs=r.ts;it.st=r.isNew?'ok':'old';
    it.msg=r.isNew?'':MM.run.mode==='two'?'เซนเซอร์อาจไม่วัดต่อหลังตัดการเชื่อมต่อ ลองโหมด "ทีละตัวจนจบ"':'เซนเซอร์อาจไม่ได้วัดใหม่';
    if(MM.run.trend){it.pct=null;it.sub='ดึง trend';mmShow();
      try{const t=await fetchTrendCore(dev,ch,{quiet:true});it.added=t.added}catch(e){it.msg=(it.msg?it.msg+' · ':'')+'ดึง trend ไม่ได้: '+e.message}
      it.sub=''}
  }catch(e){err=e;it.st='fail';it.msg=e.message}
  finally{
    ble.onProgress=null;ble.busy=false;recordHealth(dev,null,{ok:!err,attempts:ble.attempts,ms:Date.now()-t0});
    mmDisc(dev);bleFinish(dev,err);save();mmShow();
  }
}
// opt: {items:[{a,id,mac,allowBat}], mode:'two'|'seq', trend, allowStopped}
async function measureMachine(m,opt){
  if(MM.on||ble.busy)return toast('รอให้งานกับเซนเซอร์เสร็จก่อน');
  const run={id:'run-'+Date.now().toString(36),m,mode:opt.mode==='seq'?'seq':'two',trend:!!opt.trend,allowStopped:!!opt.allowStopped,t:Date.now(),
    items:opt.items.map(it=>({a:it.a,id:it.id,mac:it.mac,allowBat:!!it.allowBat,st:'wait',msg:''}))};
  if(!run.items.length)return toast('ไม่มีจุดที่เลือก');
  return mmGo(run,async()=>{
    if(run.mode==='two'){
      for(const it of run.items){if(MM.stop)break;await mmTrigger(it,true)}
      for(const it of run.items){if(MM.stop)break;if(it.st==='measuring')await mmCollect(it)}
    }else for(const it of run.items){if(MM.stop)break;await mmTrigger(it,false);if(it.st==='measuring'&&!MM.stop)await mmCollect(it)}
    // only the download is retried by itself: the capture is still in the sensor
    for(const it of run.items){if(MM.stop)break;if(it.st==='fail'&&it.trig)await mmCollect(it)}
  });
}
// collect what was measured but not downloaded yet (stopped run, page reloaded, link lost)
function mmPendingOf(run){return run?run.items.filter(it=>it.trig&&(it.st==='measuring'||it.st==='fail'||it.st==='trig'||it.st==='collect')&&Date.now()-it.trig.t0<MM_PENDING_MS):[]}
async function mmResume(){
  const run=S.mmRun;if(!run)return;const p=mmPendingOf(run);if(!p.length)return toast('ไม่มีผลที่ค้าง');
  if(MM.on||ble.busy)return toast('รอให้งานกับเซนเซอร์เสร็จก่อน');
  return mmGo(run,async()=>{for(const it of p){if(MM.stop)break;await mmCollect(it)}});
}
async function mmGo(run,work){
  MM.on=true;MM.stop=false;MM.run=run;S.mmRun=run;run.end=null;save();
  const keep={dev:ble.device,cfg:ble.cfg,autoMs:ble.timer?ble.autoMs:null};
  if(ble.liveTimer)toggleLive();
  if(ble.timer){clearInterval(ble.timer);ble.timer=null;bleLog('พักการดึงอัตโนมัติระหว่างวัดทั้งเครื่อง')}
  if(typeof updateWakeLock==='function')updateWakeLock(); // keep the screen on: a sleeping tablet drops the links
  appLog('conn',`เริ่มวัดทั้งเครื่อง "${run.m}" ${run.items.length} จุด (${run.mode==='two'?'สั่งทุกตัวก่อน แล้วเก็บผล':'ทีละตัวจนจบ'}${run.trend?' + trend':''})`);
  mmOpen();
  try{await work()}
  catch(e){bleLog('วัดทั้งเครื่องหยุดเพราะผิดพลาด: '+e.message)}
  finally{
    MM.on=false;run.end=Date.now();
    ble.device=keep.dev;ble.cfg=keep.cfg;
    if(keep.autoMs&&keep.dev){ble.autoMs=keep.autoMs;ble.autoStart=Date.now();ble.timer=setInterval(bleFetch,keep.autoMs);bleLog('ดึงอัตโนมัติต่อตามเดิม')}
    if(typeof updateWakeLock==='function')updateWakeLock();
    const n=k=>run.items.filter(it=>it.st===k).length;
    S.machineRuns=S.machineRuns||{};const L=S.machineRuns[run.m]=(S.machineRuns[run.m]||[]).filter(x=>x.id!==run.id);
    L.push({id:run.id,t:run.t,end:run.end,mode:run.mode,points:run.items.map(it=>({a:it.a,st:it.st,fftTs:it.fftTs||null,msg:it.msg||''}))});if(L.length>20)L.splice(0,L.length-20);
    appLog('data',`วัดทั้งเครื่อง "${run.m}" ${MM.stop?'(หยุดกลางทาง) ':''}เสร็จ: สำเร็จ ${n('ok')} · ชุดเดิม ${n('old')} · ข้าม ${n('skip')} · ไม่สำเร็จ ${n('fail')}${mmPendingOf(run).length?` · ค้างเก็บผล ${mmPendingOf(run).length}`:''}`);
    save();mmShow();updateBleButton();setBle('ready');
    toast(`วัดทั้งเครื่องเสร็จ: สำเร็จ ${n('ok')}/${run.items.length} จุด`);
    if(S.view==='mach')render();
  }
}

// ---------- dialog: confirm, progress, summary (one dialog, stays open while running) ----------
function mmDlg(){let d=$('#mmDlg');if(!d){d=document.createElement('dialog');d.id='mmDlg';d.className='mm-dlg';document.body.appendChild(d)}return d}
function openMeasureMachine(m){
  if(MM.on){mmOpen();return}
  const L=machineSensors(m),ready=L.filter(x=>x.state==='ready'),d=mmDlg();
  const mode=S.mmMode||'two',trend=S.mmTrend!==false;
  const row=x=>{const w=x.state==='ready'?mmWarn(x):[],hard=w.some(([k])=>k==='day'),bat=w.some(([k])=>k==='bat');
    const st=x.state==='ready'?'':x.state==='noperm'?'<span class="tag zC">ยังไม่ได้อนุญาตในเบราว์เซอร์นี้</span>':x.state==='spot'?'<span class="tag">วัดรายจุด (เซนเซอร์พกพา)</span>':'<span class="tag">ไม่มีเซนเซอร์</span>';
    const act=x.state==='noperm'?`<button type="button" class="btn sm" data-allow="${esc(x.a)}">อนุญาตเซนเซอร์</button>`:x.state==='spot'?`<button type="button" class="btn sm" data-spot="${esc(x.a)}">วัดรายจุด</button>`:'';
    return`<label class="mm-row ${x.state!=='ready'?'off':''}"><input type="checkbox" data-mmi="${esc(x.a)}" ${x.state==='ready'&&!hard&&!bat?'checked':''} ${x.state!=='ready'||hard?'disabled':''}>
      <span class="mm-name"><b>${esc(pointLabel(x.a))}</b>${x.mac?`<small class="muted mono">${esc(x.mac)}</small>`:''}${w.length?`<small class="${hard||bat?'up':'muted'}">${w.map(([,t])=>esc(t)).join(' · ')}</small>`:''}</span>${st}${act}</label>`};
  d.innerHTML=`<h3>📡 วัดทั้งเครื่อง · ${esc(m)}</h3><div class="mm-body">
    <div class="mm-list">${L.map(row).join('')}</div>
    <div class="mm-opts">
      <label class="check"><input type="radio" name="mmMode" value="two" ${mode==='two'?'checked':''}> สั่งทุกตัวก่อน แล้วเก็บผล <span class="muted">(ทุกจุดวัดเวลาใกล้กัน)</span></label>
      <label class="check"><input type="radio" name="mmMode" value="seq" ${mode==='seq'?'checked':''}> ทีละตัวจนจบ <span class="muted">(ช้ากว่า ปลอดภัยที่สุด)</span></label>
      <label class="check"><input type="checkbox" id="mmTrend" ${trend?'checked':''}> ดึง trend ใหม่ด้วย</label>
      <label class="check"><input type="checkbox" id="mmStopped"> วัดแม้เครื่องหยุด</label>
      <label class="check"><input type="checkbox" id="mmBat"> รวมตัวที่แบตต่ำ</label></div>
    <p class="muted mm-note" id="mmEst"></p>
    <p class="muted mm-note">เขียนลงเซนเซอร์แค่คำสั่ง "วัด FFT" ตัวละ 1 ครั้ง (ด่านป้องกันเดียวกับปุ่มสั่งวัด: เปลี่ยนเฉพาะช่องคำสั่งกับเวลา ค่าอื่นตรวจซ้ำหลังวัด) · ใช้แบตเซนเซอร์ตัวละ 1 FFT · ระหว่างวัดหน้าจอจะไม่ดับ · ปิดแอป i-ALERT และ Gateway ที่อาจเชื่อมเซนเซอร์ของเครื่องนี้อยู่</p>
  </div><div class="foot"><button type="button" class="btn" id="mmCancel">ยกเลิก</button><button type="button" class="btn primary" id="mmStart">เริ่มวัด</button></div>`;
  const sel=()=>[...d.querySelectorAll('[data-mmi]:checked')].map(i=>L.find(x=>x.a===i.dataset.mmi));
  const est=()=>{const md=(d.querySelector('input[name=mmMode]:checked')||{}).value,n=sel().length,e=estimateRunSec(n,md,d.querySelector('#mmTrend').checked);
    d.querySelector('#mmEst').textContent=n?`${n} จุด · ประมาณ ${Math.max(1,Math.round(e.min/60))}–${Math.max(1,Math.round(e.max/60))} นาที`:'ยังไม่ได้เลือกจุด';d.querySelector('#mmStart').disabled=!n};
  d.querySelectorAll('input').forEach(i=>i.onchange=est);
  d.querySelector('#mmBat').onchange=()=>{const on=d.querySelector('#mmBat').checked;L.forEach(x=>{if(x.state==='ready'&&mmWarn(x).some(([k])=>k==='bat')){const i=d.querySelector(`[data-mmi="${CSS.escape(x.a)}"]`);if(i&&!i.disabled)i.checked=on}});est()};
  d.querySelectorAll('[data-allow]').forEach(b=>b.onclick=async e=>{e.preventDefault();d.close();await pickAndUse();openMeasureMachine(m)});
  d.querySelectorAll('[data-spot]').forEach(b=>b.onclick=e=>{e.preventDefault();d.close();openSpot(b.dataset.spot)});
  d.querySelector('#mmCancel').onclick=()=>d.close();
  d.querySelector('#mmStart').onclick=()=>{
    const md=d.querySelector('input[name=mmMode]:checked').value,tr=d.querySelector('#mmTrend').checked,bat=d.querySelector('#mmBat').checked;
    S.mmMode=md;S.mmTrend=tr;save();
    measureMachine(m,{mode:md,trend:tr,allowStopped:d.querySelector('#mmStopped').checked,items:sel().map(x=>({...x,allowBat:bat}))});
  };
  est();if(!d.open)d.showModal();
}
function mmOpen(){const d=mmDlg();mmShow();if(!d.open)d.showModal()}
function mmShow(){
  const d=$('#mmDlg'),run=MM.run||S.mmRun;if(!d||!run||!d.open&&!MM.on)return;
  const pend=mmPendingOf(run),n=k=>run.items.filter(it=>it.st===k).length,done=!MM.on;
  const el=Math.round(((run.end||Date.now())-run.t)/1000);
  d.innerHTML=`<h3>📡 วัดทั้งเครื่อง · ${esc(run.m)} ${done?'· เสร็จแล้ว':'· กำลังวัด'}</h3><div class="mm-body">
    <p class="muted mm-note">${run.mode==='two'?'สั่งทุกตัวก่อน แล้วเก็บผล':'ทีละตัวจนจบ'}${run.trend?' + trend':''} · ${Math.floor(el/60)} นาที ${el%60} วินาที${MM.stop&&!done?' · กำลังหยุดหลังขั้นที่ทำอยู่':''}</p>
    <table class="mm-prog"><tbody>${run.items.map(it=>`<tr class="mm-${it.st}"><td><b>${esc(pointLabel(it.a))}</b></td>
      <td>${MM_ST[it.st]||it.st}${it.st==='collect'&&it.pct!=null?` ${it.pct}%`:''}${it.sub?' · '+esc(it.sub):''}${it.fftTs?`<br><small class="muted">FFT ${dFull(it.fftTs*1000)}</small>`:''}</td>
      <td class="mm-msg">${esc(it.msg||'')}</td></tr>`).join('')}</tbody></table>
    ${done?`<p class="mm-note">สำเร็จ ${n('ok')}/${run.items.length} จุด${n('old')?` · ได้ชุดเดิม ${n('old')}`:''}${n('skip')?` · ข้าม ${n('skip')}`:''}${n('fail')?` · ไม่สำเร็จ ${n('fail')}`:''}${pend.length?` · <b>ค้างเก็บผล ${pend.length} จุด</b> (FFT ยังอยู่ในเซนเซอร์)`:''}</p>`:''}
  </div><div class="foot">${done?`${pend.length?'<button type="button" class="btn" id="mmRes">เก็บผลที่ค้าง</button>':''}
      ${run.items.some(it=>(it.st==='fail'&&!it.trig)||it.st==='old')?'<button type="button" class="btn" id="mmRetry">สั่งวัดใหม่เฉพาะที่ไม่สำเร็จ</button>':''}
      <button type="button" class="btn" id="mmClose">ปิด</button><button type="button" class="btn primary" id="mmView">ดูทั้งเครื่อง</button>`
    :`<button type="button" class="btn" id="mmHide">ซ่อน (วัดต่อเบื้องหลัง)</button><button type="button" class="btn danger" id="mmStop" ${MM.stop?'disabled':''}>หยุด</button>`}</div>`;
  const on=(id,f)=>{const b=d.querySelector('#'+id);if(b)b.onclick=f};
  on('mmStop',()=>{MM.stop=true;bleLog('ขอหยุดวัดทั้งเครื่อง: ทำขั้นที่ทำอยู่ให้จบก่อน (ไม่ทิ้งคำสั่งวัดค้างไว้)');mmShow()});
  on('mmHide',()=>d.close());on('mmClose',()=>d.close());
  on('mmView',()=>{d.close();S.sel=run.items[0].a;setView('mach')});
  on('mmRes',()=>mmResume());
  on('mmRetry',()=>{const again=run.items.filter(it=>(it.st==='fail'&&!it.trig)||it.st==='old').map(it=>({a:it.a,id:it.id,mac:it.mac,allowBat:it.allowBat}));
    if(!confirm(`สั่งวัด FFT ใหม่ ${again.length} จุด? (ใช้แบตเซนเซอร์ตัวละ 1 FFT)`))return;
    measureMachine(run.m,{mode:run.mode,trend:run.trend,allowStopped:run.allowStopped,items:again})});
}
// machine page: button, unfinished run banner, and whether the spectra on the page come from one run
function mmMachineHtml(m){
  const L=machineSensors(m),n=L.filter(x=>x.state==='ready'||x.state==='noperm').length,run=S.mmRun,pend=run&&run.m===m&&!MM.on?mmPendingOf(run):[];
  return{btn:n>=1?`<button class="btn primary" id="mlMeasure" title="สั่งวัด FFT ทุกเซนเซอร์ของเครื่องนี้ครั้งเดียว">📡 วัดทั้งเครื่อง (${n} จุด)</button>`:'',
    banner:MM.on&&MM.run&&MM.run.m===m?`<div class="panel banner"><span>กำลังวัดทั้งเครื่อง…</span><button class="btn sm" onclick="mmOpen()">ดูความคืบหน้า</button></div>`
      :pend.length?`<div class="panel banner"><span>รอบวัดทั้งเครื่องเมื่อ ${dFull(run.t)} ยังค้างเก็บผล ${pend.length} จุด (FFT ยังอยู่ในเซนเซอร์)</span><button class="btn sm primary" onclick="mmResume()">เก็บผลที่ค้าง</button></div>`:''};
}
function mmSpecNote(recs){
  const ts=recs.map(r=>r.ts*1000),runs=new Set(recs.map(r=>r.run||null));if(recs.length<2)return'';
  if(runs.size===1&&!runs.has(null))return` · จากรอบวัดทั้งเครื่อง ${dFull(Math.min(...ts))}`;
  const spread=Math.max(...ts)-Math.min(...ts);
  return spread>36e5?` · <span class="up">⚠ แต่ละจุดวัดคนละเวลา (ห่างสุด ${spread>DAY?Math.round(spread/DAY)+' วัน':Math.round(spread/36e5)+' ชม.'}) กด "วัดทั้งเครื่อง" เพื่อเทียบเวลาเดียวกัน</span>`:'';
}
