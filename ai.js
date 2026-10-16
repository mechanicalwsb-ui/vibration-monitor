// AI analysis with Google Gemini. The browser talks to the Gemini API directly with the user's own
// API key; nothing goes through any other server. The key lives only in this browser's localStorage
// (separate from the dashboard state, so it is never part of a backup file).
// Only summarised numbers are sent (stats, trend, FFT peaks...), never the raw history.
// Loaded before the dashboard script; uses its globals at call time.

const AI_KEY_STORE='vibmon-gemini';
const AI_DEFAULT_MODEL='gemini-2.5-flash';
const GEMINI='https://generativelanguage.googleapis.com/v1beta/';
function aiCfg(){let c={};try{c=JSON.parse(localStorage.getItem(AI_KEY_STORE)||'{}')}catch(e){}
  return Object.assign({key:'',model:AI_DEFAULT_MODEL,anon:false,maint:true,temp:0.3},c)}
function aiSaveCfg(c){try{localStorage.setItem(AI_KEY_STORE,JSON.stringify(c))}catch(e){toast('บันทึกค่า AI ไม่ได้')}}
const aiReady=()=>!!aiCfg().key;

// ---------- Gemini client ----------
async function geminiModels(key){
  const r=await fetch(GEMINI+'models?pageSize=200',{headers:{'x-goog-api-key':key}});
  if(!r.ok)throw new Error(await aiErr(r));
  const j=await r.json();
  return(j.models||[]).filter(m=>(m.supportedGenerationMethods||[]).includes('generateContent')&&/gemini/i.test(m.name))
    .map(m=>({id:m.name.replace(/^models\//,''),label:m.displayName||m.name}));
}
async function aiErr(r){
  let msg='';try{const j=await r.json();msg=j.error&&j.error.message||''}catch(e){}
  if(r.status===400&&/API key/i.test(msg))return 'API key ไม่ถูกต้อง';
  if(r.status===403)return 'API key นี้ไม่มีสิทธิ์ใช้ Gemini API ('+msg+')';
  if(r.status===404)return 'ไม่พบโมเดลนี้ ลองกด "โหลดรายชื่อโมเดล" แล้วเลือกใหม่';
  if(r.status===429)return 'ใช้เกินโควตาของ API key (รอสักครู่ หรือดูโควตาใน Google AI Studio)';
  return `Gemini ตอบกลับ ${r.status}: ${msg||r.statusText}`;
}
// Streams the answer; onText(fullTextSoFar) is called as chunks arrive. Returns the full text.
async function geminiStream(contents,system,onText,signal){
  const c=aiCfg();if(!c.key)throw new Error('ยังไม่ได้ใส่ Gemini API key (ตั้งค่า → AI)');
  const body={contents,systemInstruction:{parts:[{text:system}]},
    generationConfig:{temperature:c.temp,maxOutputTokens:8192}};
  const r=await fetch(`${GEMINI}models/${encodeURIComponent(c.model)}:streamGenerateContent?alt=sse`,
    {method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':c.key},body:JSON.stringify(body),signal});
  if(!r.ok)throw new Error(await aiErr(r));
  const rd=r.body.getReader(),dec=new TextDecoder();let buf='',text='',finish='';
  for(;;){
    const{value,done}=await rd.read();if(done)break;
    buf+=dec.decode(value,{stream:true});
    let i;while((i=buf.indexOf('\n'))>=0){
      const line=buf.slice(0,i).trim();buf=buf.slice(i+1);
      if(!line.startsWith('data:'))continue;
      let j;try{j=JSON.parse(line.slice(5))}catch(e){continue}
      const cand=j.candidates&&j.candidates[0];
      if(cand){for(const p of(cand.content&&cand.content.parts)||[])if(p.text&&!p.thought)text+=p.text;if(cand.finishReason)finish=cand.finishReason}
      if(j.promptFeedback&&j.promptFeedback.blockReason)throw new Error('Gemini ไม่ตอบคำถามนี้ ('+j.promptFeedback.blockReason+')');
      onText(text);
    }
  }
  if(!text)throw new Error('Gemini ไม่ได้ส่งคำตอบกลับมา'+(finish?' ('+finish+')':''));
  if(finish==='MAX_TOKENS')text+='\n\n_(คำตอบถูกตัดเพราะยาวเกินกำหนด)_';
  return text;
}

// ---------- what we tell the model ----------
const AI_SYSTEM=`คุณเป็นวิศวกรวิเคราะห์การสั่นสะเทือน (Vibration Analyst ระดับ ISO 18436-2 Category II) ช่วยช่างซ่อมบำรุงในโรงงานประเมินสภาพเครื่องจักรหมุน (ปั๊ม มอเตอร์ พัดลม) จากข้อมูลเซนเซอร์ไร้สาย ITT Goulds i-ALERT3
ข้อมูลที่ได้รับเป็นค่าสรุป:
- velocity RMS (mm/s) แยกแกน X=Vertical, Y=Axial, Z=Horizontal, acceleration RMS (g), อุณหภูมิผิว (°C) และ RPM
- สเปกตรัม FFT: ยอดสูงสุดพร้อมเท่าของรอบ (order), พลังงานตามช่วงความถี่, สถิติ waveform, ผล envelope
- ผลวิเคราะห์ตามกฎเบื้องต้นของระบบ, แนวโน้ม/พยากรณ์, ช่วงที่ไม่มีข้อมูล, บันทึกซ่อม และสุขภาพเซนเซอร์
หลักการตอบ:
1. ตอบเป็นภาษาไทย กระชับ ใช้หัวข้อ Markdown และ bullet ช่างอ่านแล้วนำไปทำงานได้ทันที
2. ใช้เฉพาะข้อมูลที่ให้มา ห้ามแต่งตัวเลข ถ้าข้อมูลไม่พอให้บอกตรง ๆ ว่าขาดอะไร และควรเก็บข้อมูลอะไรเพิ่ม
3. อ้างอิงหลักทั่วไป เช่น ISO 10816-3/20816-3, 1X=unbalance, 2X/แนวแกนสูง=misalignment, harmonics/sub-harmonics=looseness, ยอดที่ BPFO/BPFI/BSF/FTF หรือ kurtosis/ความถี่สูงเพิ่ม=bearing, vane pass=ปัญหาการไหล/ใบพัด
4. ระบุระดับความมั่นใจ (สูง/ปานกลาง/ต่ำ) ของแต่ละข้อสันนิษฐาน และเหตุผลที่อ้างจากข้อมูล
5. คำแนะนำต้องปลอดภัย ไม่แนะนำให้เปลี่ยนค่าตั้งค่าในเซนเซอร์ และย้ำว่าก่อนตัดสินใจซ่อมใหญ่ควรให้ผู้เชี่ยวชาญยืนยัน
6. ถ้าเห็นปัญหาของข้อมูลเอง (เช่น นาฬิกาเซนเซอร์รีเซ็ต ข้อมูลขาด ค่าตอนเครื่องหยุด) ให้แยกออกจากปัญหาของเครื่องจักร`;

const r2=v=>v==null||!isFinite(v)?null:Math.round(v*100)/100;
const r3=v=>v==null||!isFinite(v)?null:Math.round(v*1000)/1000;
function statsOf(rs,c){
  const run=rs.filter(r=>isRunning(r,c)!==false),pick=k=>run.map(r=>r[k]).filter(v=>v!=null);
  const s=a=>a.length?{mean:r2(mean(a)),max:r2(Math.max(...a)),p95:r2(quantile(a,.95))}:null;
  const t=rs.map(r=>r.temp).filter(v=>v!=null);
  return{n:rs.length,running:run.length,vx:s(pick('vx')),vy:s(pick('vy')),vz:s(pick('vz')),
    accMax:r3(Math.max(0,...run.map(accMax).filter(v=>v!=null))),temp:t.length?{mean:r2(mean(t)),max:r2(Math.max(...t))}:null};
}
// Peaks over all axes of one FFT capture (velocity, low band, from 2 Hz)
function aiFftSummary(rec,c){
  const dec=faDecode(rec);if(!dec)return null;
  const per={x:[],y:[],z:[]};for(const a of['x','y','z'])per[a]=specPoints(dec,'low','vel',a).filter(p=>p.x>=2);
  const env=per.x.map((p,i)=>{let y=-1,ax='x';for(const a of['x','y','z']){const v=per[a][i]&&per[a][i].y;if(Number.isFinite(v)&&v>y){y=v;ax=a}}return{x:p.x,y,ax}});
  const rs=faRunSpeed(dec,c),f1=rs.f1;
  const peaks=faPeaks(env,10).map(p=>({hz:r2(p.x),mm_s:r3(p.y),axis:p.ax.toUpperCase(),order:f1?r2(p.x/f1):null}));
  const B=dec.low||dec.single,wave={};
  if(B&&B.twf)for(const a of['x','y','z']){const w=faWaveStats(B.twf[a]);if(w)wave[a.toUpperCase()]={peak_g:r3(w.peak),rms_g:r3(w.rms),crest:r2(w.crest),kurtosis:r2(w.kurt)}}
  const out={measured:new Date(rec.ts*1000).toLocaleString('th-TH'),kind:rec.kind||'alarm',runSpeed:f1?{hz:r2(f1),rpm:Math.round(f1*60),source:rs.src}:null,
    topPeaks:peaks,waveform:wave,ruleDiagnosis:diagnose(dec,f1?f1*60:null,null,c).items.map(i=>`${i.name} (${i.level}): ${i.why}`)};
  if(f1){const band=(lo,hi)=>r3(Math.max(...['x','y','z'].map(a=>faRss(per[a],lo,hi)))); // per-axis band RMS, worst axis
    out.bandRms_mm_s={'<0.8X':band(2,0.8*f1),'1X':band(0.8*f1,1.2*f1),'2X':band(1.8*f1,2.2*f1),'3-10X':band(2.8*f1,10.2*f1),'>10X':band(10.2*f1,Infinity)}}
  if(dec.high&&dec.high.gfft&&dec.high.startBin!=null){let q=0,n=0;const hb=dec.high.hzPerBin;
    for(let i=Math.max(dec.high.startBin,Math.round(1000/hb));i<=dec.high.endBin;i++)for(const a of['x','y','z']){const v=dec.high.gfft[a][i];if(Number.isFinite(v)){q+=v*v;n++}}
    out.hiFreq_1to5kHz_g=r3(Math.sqrt(q/3))}
  // envelope check at the bearing frequencies when the bearing is known
  const bf=bearingFreqs(f1,c.bearing),H=dec.high&&dec.high.twf&&dec.high.twfSampleRate?dec.high:B;
  if(bf&&H&&H.twf&&H.twfSampleRate){
    const nyq=H.twfSampleRate/2,e=envSpectrum(H.twf.x,H.twfSampleRate,nyq*0.2,nyq*0.9);
    if(e){const ys=e.pts.map(p=>p.y).sort((a,b)=>a-b),med=ys[Math.floor(ys.length/2)]||1e-12;
      const at=f=>{let m=0;for(const p of e.pts)if(Math.abs(p.x-f)<=Math.max(2*e.df,f*0.03))m=Math.max(m,p.y);return m};
      out.envelope={rms_gE:r3(e.rms),bearingFreqHz:Object.fromEntries(Object.entries(bf).map(([k,v])=>[k,r2(v)])),
        peakOverFloor:Object.fromEntries(Object.entries(bf).map(([k,v])=>[k,[1,2,3].map(h=>r2(at(h*v)/med))]))}}
  }
  return out;
}
async function buildAIContext(asset,opt={}){
  const c=cfg(asset),all=series(asset),last=all.at(-1),cf=aiCfg();
  const name=cf.anon?'เครื่อง A':asset,pr=c.profile||{},end=last.t;
  const win=d=>all.filter(r=>r.t>end-d*DAY);
  const lim=effLimits(c,'ov'),fc=forecast(all,c,'ov'),ri=runInfo(win(7),c),gaps=findGaps(win(90),asset,c).slice(-5);
  const daily=aggregate(win(30),c,'day').map(g=>[g.k.slice(5),r2(g.avg),r2(g.max)]);
  const ctx={
    machine:{name,type:pr.type||null,kW:pr.kw||null,rpmNominal:c.rpm||null,vanes:c.vanes||null,foundation:pr.found||null,
      sensorMount:pr.mount||null,bearing:pr.brg&&pr.brg[pr.brgUse||'de']&&pr.brg[pr.brgUse||'de'].code||null},
    thresholds_mm_s:{source:useSensorThr(c)?'ตั้งในเซนเซอร์':'ISO 10816-3 '+((CLASSES[c.cls]||{}).n||''),warn:r2(lim.warn),alarm:r2(lim.alarm),
      tempWarn:tempLimits(c).tw,tempAlarm:tempLimits(c).ta},
    latest:{time:new Date(last.t).toLocaleString('th-TH'),status:ZL[status(last,c)]||null,v_mm_s:{X:r2(last.vx),Y:r2(last.vy),Z:r2(last.vz)},
      acc_g:{X:r3(last.ax),Y:r3(last.ay),Z:r3(last.az)},tempC:r2(last.temp),rpm:last.rpm||null},
    stats:{last24h:statsOf(win(1),c),last7d:statsOf(win(7),c),last30d:statsOf(win(30),c),last90d:statsOf(win(90),c)},
    dailyMeanMax_last30d:daily,
    trend:fc.ok?{model:fc.kind,perWeek_mm_s:r3(fc.perWeek),r2:r2(fc.r2),daysToWarn:fc.dWarn!=null?Math.round(fc.dWarn):null,daysToAlarm:fc.dAlarm!=null?Math.round(fc.dAlarm):null}:{note:fc.why},
    operation:{runHours7d:Math.round(ri.runH),starts7d:ri.starts,stopThreshold_mm_s:runMin(c)},
    dataGaps90d:gaps.map(g=>({from:new Date(g.from).toLocaleString('th-TH'),hours:Math.round(g.dur/36e5),cause:g.cause})),
    baseline:c.baseline?{mean_mm_s:c.baseline.mean.map(r2),changePct:r2(baselineDelta(last,c)),used:!!c.useBaseline}:null,
  };
  if(cf.maint){const ml=(S.maint||[]).filter(m=>m.asset===asset).sort((a,b)=>b.t-a.t).slice(0,10);
    if(ml.length)ctx.maintenance=ml.map(m=>({date:new Date(m.t).toLocaleDateString('th-TH'),type:m.type,detail:m.text||''}))}
  const sid=Object.keys(S.sensors).find(id=>S.sensors[id].asset===asset);
  if(sid){const h=healthSummary(sid);if(h.score!=='none')ctx.sensorHealth={battery_V:h.last&&h.last.batt||null,issues:h.issues.map(i=>i[1])}}
  if(opt.fft!==false){let list=[];try{list=await FFTDB.list(asset)}catch(e){}
    const rec=opt.fftKey?list.find(r=>r.key===opt.fftKey):list[0];
    if(rec){const f=aiFftSummary(rec,c);if(f)ctx.fft=f}
    if(list.length>1){const prev=aiFftSummary(list[1],c);if(prev)ctx.fftPrevious={measured:prev.measured,topPeaks:prev.topPeaks.slice(0,5)}}}
  return ctx;
}
function fleetContext(){
  const cf=aiCfg();
  return names().map((a,i)=>{const c=cfg(a),all=series(a),last=all.at(-1),fc=forecast(all,c,'ov'),s7=statsOf(all.filter(r=>r.t>last.t-7*DAY),c);
    const m=(S.maint||[]).filter(x=>x.asset===a).sort((x,y)=>y.t-x.t)[0];
    return{name:cf.anon?'เครื่อง '+String.fromCharCode(65+i):a,status:ZL[status(last,c)]||null,latestOverall_mm_s:r2(overall(last)),tempC:r2(last.temp),
      lastDataAgeH:Math.round((Date.now()-last.t)/36e5),mean7d_mm_s:s7.vx?{X:s7.vx.mean,Y:s7.vy&&s7.vy.mean,Z:s7.vz&&s7.vz.mean}:null,
      alarm_mm_s:r2(effLimits(c,'ov').alarm),trendPerWeek:fc.ok?r3(fc.perWeek):null,daysToAlarm:fc.ok&&fc.dAlarm!=null?Math.round(fc.dAlarm):null,
      lastMaintenance:m&&cf.maint?`${new Date(m.t).toLocaleDateString('th-TH')} ${m.type}`:null}});
}
const AI_TASKS={
  machine:{label:'วิเคราะห์สภาพเครื่องนี้',prompt:`วิเคราะห์สภาพเครื่องจักรจากข้อมูลด้านล่าง ตอบตามหัวข้อ:
## สรุปสภาพ (1–2 บรรทัด พร้อมระดับ: ปกติ / เฝ้าระวัง / ต้องวางแผนซ่อม / ต้องหยุดตรวจด่วน)
## สิ่งที่พบ (อ้างตัวเลขจากข้อมูล)
## สาเหตุที่เป็นไปได้ (เรียงจากมากไปน้อย พร้อมความมั่นใจและเหตุผล)
## สิ่งที่ควรทำ (แยก: ทำทันที / ภายใน 1–2 สัปดาห์ / ติดตามต่อ)
## ข้อมูลที่ควรเก็บเพิ่ม`},
  fft:{label:'อธิบายผล FFT ล่าสุด',prompt:`อธิบายสเปกตรัม FFT ชุดล่าสุดให้ช่างเข้าใจ: ยอดแต่ละยอดน่าจะมาจากอะไร (เทียบ order ของรอบ, bearing, vane pass, ไฟฟ้า 50/100 Hz), envelope บอกอะไร, เทียบกับชุดก่อนหน้าถ้ามี, และสรุปว่าต้องตรวจอะไรเพิ่ม ถ้าไม่มีข้อมูล FFT ให้บอกวิธีเก็บ`},
  maint:{label:'วางแผนบำรุงรักษา',prompt:`จากข้อมูลด้านล่าง วางแผนบำรุงรักษาเชิงคาดการณ์ของเครื่องนี้: ควรทำอะไร เมื่อไร (อิงแนวโน้มและพยากรณ์), อะไหล่/เครื่องมือที่ควรเตรียม, ความถี่ในการวัด FFT ที่เหมาะสม และจุดที่ควรตรวจด้วยตา/หู ระหว่างเดินตรวจ`},
};
const AI_FLEET_PROMPT=`ด้านล่างเป็นสรุปเครื่องจักรทุกเครื่องในโรงงาน จัดลำดับความสำคัญว่าควรดูเครื่องไหนก่อน ตอบตามหัวข้อ:
## ภาพรวม (ปกติกี่เครื่อง / ต้องดูกี่เครื่อง)
## ลำดับเครื่องที่ต้องจัดการ (ตาราง: ลำดับ | เครื่อง | ปัญหา | ควรทำ | ภายในเมื่อไร)
## ข้อสังเกตด้านข้อมูล (เครื่องที่ข้อมูลเก่า/ขาด)
## แผนงานสัปดาห์นี้ (สั้น ๆ)`;

// ---------- tiny Markdown renderer (escaped first, so model output cannot inject HTML) ----------
function mdToHtml(src){
  const lines=esc(src).replace(/\r/g,'').split('\n'),out=[];let list=null,table=null;
  const inline=s=>s.replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g,'$1<i>$2</i>').replace(/`([^`]+)`/g,'<code>$1</code>').replace(/_\((.+?)\)_/g,'<i>($1)</i>');
  const close=()=>{if(list){out.push(`</${list}>`);list=null}if(table){out.push('</tbody></table></div>');table=null}};
  for(const raw of lines){const l=raw.trimEnd();
    if(/^\s*\|.*\|\s*$/.test(l)){
      const cells=l.trim().slice(1,-1).split('|').map(x=>x.trim());
      if(cells.every(x=>/^:?-{2,}:?$/.test(x)))continue;
      if(!table){close();out.push('<div class="tablewrap" style="max-height:none"><table class="ai-t"><thead><tr>'+cells.map(x=>`<th>${inline(x)}</th>`).join('')+'</tr></thead><tbody>');table=true;continue}
      out.push('<tr>'+cells.map(x=>`<td>${inline(x)}</td>`).join('')+'</tr>');continue}
    let m;
    if((m=l.match(/^(#{1,4})\s+(.*)/))){close();const n=Math.min(4,m[1].length+2);out.push(`<h${n}>${inline(m[2])}</h${n}>`);continue}
    if((m=l.match(/^\s*[-*•]\s+(.*)/))){if(list!=='ul'){close();out.push('<ul>');list='ul'}out.push(`<li>${inline(m[1])}</li>`);continue}
    if((m=l.match(/^\s*\d+[.)]\s+(.*)/))){if(list!=='ol'){close();out.push('<ol>');list='ol'}out.push(`<li>${inline(m[1])}</li>`);continue}
    close();if(l.trim())out.push(`<p>${inline(l)}</p>`);
  }
  close();return out.join('');
}

// ---------- AI page ----------
const AI={busy:false,ctrl:null,chat:{},showCtx:false};
function aiHist(asset){return(S.ai[asset]||(S.ai[asset]=[]))}
function renderAIPage(){
  const p=$('#aiPage'),ns=names(),a=S.sel,cf=aiCfg();
  if(!cf.key){p.innerHTML=`<div class="mainhead"><h2>วิเคราะห์ด้วย AI (Gemini)</h2></div><div class="panel empty"><h2>ใส่ Gemini API key ก่อน</h2>
    <p>ขอ API key ฟรีได้ที่ Google AI Studio (aistudio.google.com → Get API key) แล้วนำมาใส่ในหน้า ตั้งค่า → AI (Gemini) · key เก็บในเบราว์เซอร์นี้เท่านั้น</p>
    <button class="btn primary" onclick="S._setFocus='ai';setView('settings')">ไปที่ตั้งค่า AI</button></div>`;return}
  if(!a||!ns.includes(a)){p.innerHTML='<div class="panel empty"><h2>ยังไม่มีข้อมูลเครื่องจักร</h2></div>';return}
  const chat=AI.chat[a]||[],hist=aiHist(a);
  p.innerHTML=`<div class="mainhead"><h2>วิเคราะห์ด้วย AI · ${esc(a)}</h2><span class="muted" style="font-size:12px">โมเดล ${esc(cf.model)}</span></div>
  <div class="panel pbody">
    <div class="row">${Object.entries(AI_TASKS).map(([k,t])=>`<button class="btn ${k==='machine'?'primary':''}" data-task="${k}" ${AI.busy?'disabled':''}>${t.label}</button>`).join('')}
      <button class="btn" id="aiFleet" ${AI.busy?'disabled':''}>สรุปทุกเครื่อง (${ns.length})</button>
      ${AI.busy?'<button class="btn danger" id="aiStop">หยุด</button>':''}
      <button class="btn sm" id="aiCtx" style="margin-left:auto">${AI.showCtx?'ซ่อน':'ดู'}ข้อมูลที่จะส่ง</button></div>
    <p class="muted" style="margin:8px 0 0;font-size:12px">ส่งเฉพาะค่าสรุป (สถิติ แนวโน้ม ยอด FFT บันทึกซ่อม) ไปที่ Google Gemini ${cf.anon?'· ซ่อนชื่อเครื่องอยู่':''} · ผลจาก AI เป็นความเห็นประกอบ ควรให้ผู้เชี่ยวชาญยืนยันก่อนตัดสินใจซ่อม</p>
    ${AI.showCtx?`<pre class="ai-ctx" id="aiCtxBox">กำลังเตรียม…</pre>`:''}
  </div>
  <div class="panel ai-chat" id="aiChat">${chat.length?chat.map(m=>`<div class="ai-msg ${m.role}">${m.role==='user'?`<div class="ai-q">${esc(m.show||m.text)}</div>`:`<div class="ai-a">${mdToHtml(m.text)}</div>`}</div>`).join(''):'<p class="muted" style="margin:0">กดปุ่มด้านบนเพื่อเริ่มวิเคราะห์ หรือพิมพ์คำถามเกี่ยวกับเครื่องนี้ด้านล่าง</p>'}</div>
  <div class="panel pbody ai-ask"><textarea id="aiQ" rows="2" placeholder="ถามต่อ เช่น ถ้าเปลี่ยน bearing แล้วค่ายังสูง ควรตรวจอะไร?" ${AI.busy?'disabled':''}></textarea>
    <div class="row"><button class="btn primary" id="aiSend" ${AI.busy?'disabled':''}>ส่งคำถาม</button>${chat.length?`<button class="btn" id="aiSave">บันทึกคำตอบล่าสุด</button><button class="btn" id="aiClear">เริ่มใหม่</button>`:''}</div></div>
  <div class="panel"><div class="ph"><h3>ผลวิเคราะห์ที่บันทึกไว้ (${hist.length})</h3></div><div class="pbody">
    ${hist.length?`<ul class="klist">${hist.slice().reverse().map(h=>`<li><div><b>${esc(h.title)}</b><div class="muted" style="font-size:12px">${dFull(h.t)} · ${esc(h.model)}</div></div>
      <div class="row"><button class="btn sm" data-hview="${h.id}">อ่าน</button><button class="btn sm danger" data-hdel="${h.id}">ลบ</button></div></li>`).join('')}</ul>`
      :'<p class="muted" style="margin:0">ยังไม่มี · ผลที่บันทึกจะแสดงในรายงาน PDF ได้</p>'}</div></div>`;
  p.querySelectorAll('[data-task]').forEach(b=>b.onclick=()=>aiRunTask(a,b.dataset.task));
  $('#aiFleet').onclick=()=>aiRunFleet(a);
  if($('#aiStop'))$('#aiStop').onclick=()=>{if(AI.ctrl)AI.ctrl.abort()};
  $('#aiCtx').onclick=()=>{AI.showCtx=!AI.showCtx;renderAIPage()};
  if(AI.showCtx)buildAIContext(a).then(c=>{const el=$('#aiCtxBox');if(el)el.textContent=JSON.stringify(c,null,1)});
  const send=()=>{const q=$('#aiQ').value.trim();if(q)aiAsk(a,q,q)};
  $('#aiSend').onclick=send;$('#aiQ').onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey))send()};
  if($('#aiSave'))$('#aiSave').onclick=()=>aiSaveLast(a);
  if($('#aiClear'))$('#aiClear').onclick=()=>{AI.chat[a]=[];renderAIPage()};
  p.querySelectorAll('[data-hview]').forEach(b=>b.onclick=()=>{const h=hist.find(x=>x.id===b.dataset.hview);
    infoDialog(esc(h.title)+' · '+dFull(h.t),`<div class="ai-a">${mdToHtml(h.text)}</div><p class="muted" style="font-size:12px">${esc(h.model)}</p>`)});
  p.querySelectorAll('[data-hdel]').forEach(b=>b.onclick=()=>{if(!confirm('ลบผลวิเคราะห์นี้?'))return;S.ai[a]=hist.filter(x=>x.id!==b.dataset.hdel);save();renderAIPage()});
  const box=$('#aiChat');box.scrollTop=box.scrollHeight;
}
async function aiRunTask(asset,task){
  const ctx=await buildAIContext(asset,{fft:true});
  const t=AI_TASKS[task];
  AI.chat[asset]=[]; // a task starts a fresh conversation with the data attached
  aiAsk(asset,`${t.prompt}\n\nข้อมูล (JSON):\n${JSON.stringify(ctx)}`,t.label,t.label);
}
async function aiRunFleet(asset){
  AI.chat[asset]=[];
  aiAsk(asset,`${AI_FLEET_PROMPT}\n\nข้อมูล (JSON):\n${JSON.stringify(fleetContext())}`,'สรุปทุกเครื่อง','สรุปทุกเครื่อง');
}
// Follow-up questions keep the conversation; a first free question gets the machine data attached
async function aiAsk(asset,text,show,title){
  if(AI.busy)return;
  const chat=AI.chat[asset]||(AI.chat[asset]=[]);
  if(!chat.length&&!title){const ctx=await buildAIContext(asset);text=`คำถามเกี่ยวกับเครื่องจักรนี้: ${text}\n\nข้อมูล (JSON):\n${JSON.stringify(ctx)}`}
  chat.push({role:'user',text,show});
  const ans={role:'model',text:'',title:title||show.slice(0,60)};chat.push(ans);
  AI.busy=true;AI.ctrl=new AbortController();renderAIPage();
  const el=()=>{const n=$('#aiChat');return n&&n.lastElementChild&&n.lastElementChild.querySelector('.ai-a')};
  let lastDraw=0;
  try{
    // failed turns (and the question that caused them) are not sent back to the model
    const hist=chat.slice(0,-1).filter((m,i,arr)=>!m.err&&!(m.role==='user'&&arr[i+1]&&arr[i+1].err));
    ans.text=await geminiStream(hist.map(m=>({role:m.role,parts:[{text:m.text}]})),AI_SYSTEM,txt=>{
      ans.text=txt;if(Date.now()-lastDraw>120){lastDraw=Date.now();const e=el();if(e){e.innerHTML=mdToHtml(txt);const b=$('#aiChat');b.scrollTop=b.scrollHeight}}},AI.ctrl.signal);
  }catch(e){
    ans.text=(ans.text?ans.text+'\n\n':'')+(e.name==='AbortError'?'_(หยุดแล้ว)_':'**ผิดพลาด:** '+e.message);ans.err=true;
  }finally{AI.busy=false;AI.ctrl=null;if(S.view==='ai'&&S.sel===asset)renderAIPage()}
}
function aiSaveLast(asset){
  const chat=AI.chat[asset]||[],m=chat.slice().reverse().find(x=>x.role==='model'&&!x.err&&x.text);
  if(!m)return toast('ยังไม่มีคำตอบให้บันทึก');
  aiHist(asset).push({id:uid(),t:Date.now(),title:m.title||'ผลวิเคราะห์',text:m.text,model:aiCfg().model});
  if(S.ai[asset].length>30)S.ai[asset].shift();save();renderAIPage();toast('บันทึกผลวิเคราะห์แล้ว');
}

// ---------- settings panel ----------
function aiSettingsHtml(){
  const c=aiCfg();
  return`<div class="panel" id="aiSetPanel"><div class="ph"><h3>AI (Google Gemini)</h3></div><div class="form">
    <label class="full">Gemini API key<span class="row" style="flex-wrap:nowrap"><input type="password" id="aiKey" value="${esc(c.key)}" placeholder="วาง API key จาก Google AI Studio" autocomplete="off" style="flex:1"><button class="btn sm" id="aiKeyShow" type="button">แสดง</button></span></label>
    <label class="full">โมเดล<span class="row" style="flex-wrap:nowrap"><input type="text" id="aiModel" list="aiModels" value="${esc(c.model)}" style="flex:1"><button class="btn sm" id="aiList" type="button">โหลดรายชื่อโมเดล</button></span><datalist id="aiModels"></datalist></label>
    <label>ความสร้างสรรค์ของคำตอบ<select id="aiTemp">${[[0.1,'ตรงตัวมาก'],[0.3,'สมดุล (แนะนำ)'],[0.7,'ยืดหยุ่น']].map(([v,l])=>`<option value="${v}" ${c.temp===v?'selected':''}>${l}</option>`).join('')}</select></label>
    <div style="align-self:end"><button class="btn" id="aiTest" type="button">ทดสอบ</button></div>
    <label class="full check"><input type="checkbox" id="aiAnon" ${c.anon?'checked':''}> ซ่อนชื่อเครื่องจักร (ส่งเป็น "เครื่อง A")</label>
    <label class="full check"><input type="checkbox" id="aiMaint" ${c.maint?'checked':''}> ส่งบันทึกซ่อมไปประกอบการวิเคราะห์</label>
    <p class="full muted" style="margin:0;font-size:12px" id="aiInfo">ขอ key ฟรีที่ aistudio.google.com → Get API key · key เก็บในเบราว์เซอร์นี้เท่านั้น ไม่อยู่ในไฟล์สำรอง และส่งตรงไปที่ Google เท่านั้น · ใช้ฟรีได้ภายในโควตาของ Google (ถ้าเปิด billing จะคิดเงินตามการใช้) · อย่าใช้ key นี้บนเครื่องที่คนอื่นใช้ร่วม</p>
  </div></div>`;
}
function aiBindSettings(){
  if(!$('#aiSetPanel'))return;
  const upd=()=>{const c=aiCfg();Object.assign(c,{key:$('#aiKey').value.trim(),model:$('#aiModel').value.trim()||AI_DEFAULT_MODEL,
    temp:+$('#aiTemp').value,anon:$('#aiAnon').checked,maint:$('#aiMaint').checked});aiSaveCfg(c)};
  ['aiKey','aiModel','aiTemp','aiAnon','aiMaint'].forEach(id=>$('#'+id).onchange=upd);
  $('#aiKeyShow').onclick=()=>{const i=$('#aiKey');i.type=i.type==='password'?'text':'password';$('#aiKeyShow').textContent=i.type==='password'?'แสดง':'ซ่อน'};
  $('#aiList').onclick=async()=>{upd();const k=aiCfg().key;if(!k)return toast('ใส่ API key ก่อน');
    try{const ms=await geminiModels(k);$('#aiModels').innerHTML=ms.map(m=>`<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
      $('#aiInfo').textContent=`พบ ${ms.length} โมเดล: ${ms.slice(0,12).map(m=>m.id).join(', ')}${ms.length>12?' …':''} — คลิกช่องโมเดลเพื่อเลือก`}
    catch(e){$('#aiInfo').textContent='โหลดรายชื่อไม่ได้: '+e.message}};
  $('#aiTest').onclick=async()=>{upd();$('#aiInfo').textContent='กำลังทดสอบ…';
    try{const t=await geminiStream([{role:'user',parts:[{text:'ตอบสั้น ๆ คำเดียวว่า "พร้อม"'}]}],'ตอบภาษาไทย',()=>{});$('#aiInfo').textContent=`ใช้งานได้ ✓ (${aiCfg().model} ตอบว่า: ${t.trim().slice(0,40)})`}
    catch(e){$('#aiInfo').textContent='ใช้งานไม่ได้: '+e.message}};
  if(S._setFocus==='ai'){S._setFocus=null;$('#aiSetPanel').scrollIntoView({behavior:'smooth'});$('#aiKey').focus()}
}
