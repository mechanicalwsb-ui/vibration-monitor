// FFT tools added after comparing with Adash DDS: cursors, audio playback, motor/gear markers,
// spectral band alarms, fault indicators, reference spectrum mask, cepstrum/autocorrelation/circular
// waveform, spectrograph, bump test, 3D motion at the sensor point and spectrum/TWF CSV import.
// All read-only towards the sensor. Loaded after fft-analysis.js; uses globals at call time.

// ---------- raw spectra (base units: mm/s and g, independent of display unit) ----------
function rawSpec(dec,band,qty,a){
  const B=dec.single||(band==='high'?dec.high:dec.low);if(!B||!B.freq)return[];
  const key=qty==='acc'?'gfft':'vfft';if(!B[key])return[];
  const s=Math.max(1,B.startBin||1),e=B.endBin!=null?B.endBin:B.freq.length-1,out=[];
  for(let i=s;i<=e;i++){const y=B[key][a][i];if(Number.isFinite(y))out.push({x:B.freq[i],y})}
  return qty==='acc'?out:out.filter(p=>p.x>=VEL_MIN_HZ);
}
const hasHigh=dec=>!!(dec&&dec.high&&dec.high.startBin!=null&&dec.high.freq);
function peakAt(pts,f,tolHz){let m=0;for(const p of pts)if(Math.abs(p.x-f)<=tolHz&&p.y>m)m=p.y;return m}
function rssBand(pts,lo,hi){let q=0;for(const p of pts)if(p.x>=lo&&p.x<hi)q+=p.y*p.y;return Math.sqrt(q)}

// ---------- machine frequencies: motor, gear, belt (A6) ----------
// c.drive = {poles, lineHz, bars, teeth, beltRatio}
function motorFreqs(f1,c){
  const d=c.drive||{};if(!f1||!d.poles)return null;
  const lf=d.lineHz||50,sync=2*lf/d.poles,slip=Math.max(0,sync-f1);
  return{lf,sync,slip,ppf:d.poles*slip,rbpf:d.bars?d.bars*f1:null};
}
function machineMarks(f1,c,fmax,k){
  const L=[],d=c.drive||{};
  const m=motorFreqs(f1,c);
  if(m){L.push({x:2*m.lf,label:'2×LF',color:k.t});
    if(m.ppf>0.05)[-1,1].forEach(s=>L.push({x:f1+s*m.ppf,label:s<0?'1X−PPF':'1X+PPF',color:k.t}));
    if(m.rbpf&&m.rbpf<=fmax){L.push({x:m.rbpf,label:'RBPF',color:k.t});[-1,1].forEach(s=>L.push({x:m.rbpf+s*2*m.lf,label:s<0?'RBPF−2LF':'RBPF+2LF',color:k.t}))}}
  if(f1&&d.teeth){const g=d.teeth*f1;for(let h=1;h<=3&&h*g<=fmax;h++){L.push({x:h*g,label:h>1?h+'×GMF':'GMF',color:k.y});
    [-2,-1,1,2].forEach(s=>L.push({x:h*g+s*f1,label:'',color:k.y}))}}
  if(f1&&d.beltRatio){const fp=f1*d.beltRatio;L.push({x:fp,label:'1X ปั๊ม/ตัวตาม',color:k.z},{x:2*fp,label:'2X ตัวตาม',color:k.z})}
  return L;
}

// ---------- spectral bands (A1) ----------
// c.bands = [{id,name,lo,hi,unit:'X'|'Hz',qty:'vel'|'acc',src:'low'|'high',warn,alarm}]
function defaultBands(){const u=()=>uid();return[
  {id:u(),name:'Sub-sync (0.3–0.8X)',lo:0.3,hi:0.8,unit:'X',qty:'vel',src:'low'},
  {id:u(),name:'1X',lo:0.8,hi:1.2,unit:'X',qty:'vel',src:'low'},
  {id:u(),name:'2X',lo:1.8,hi:2.2,unit:'X',qty:'vel',src:'low'},
  {id:u(),name:'3X–10X',lo:2.8,hi:10.2,unit:'X',qty:'vel',src:'low'},
  {id:u(),name:'> 10X',lo:10.2,hi:80,unit:'X',qty:'vel',src:'low'},
  {id:u(),name:'HF 1–5 kHz (g)',lo:1000,hi:5000,unit:'Hz',qty:'acc',src:'high'}]}
function bandRange(b,f1){if(b.unit==='X'){if(!f1)return null;return[b.lo*f1,b.hi*f1]}return[b.lo,b.hi]}
function bandValue(dec,b,f1){
  const r=bandRange(b,f1);if(!r)return null;
  const src=b.src==='high'&&hasHigh(dec)?'high':'low';if(b.src==='high'&&!hasHigh(dec)&&!dec.single)return null;
  let worst=0,ax='x';for(const a of['x','y','z']){const v=rssBand(rawSpec(dec,src,b.qty,a),r[0],r[1]);if(v>worst){worst=v;ax=a}}
  return{v:worst,ax};
}
const bandZone=(b,v)=>v==null?null:b.alarm!=null&&v>=b.alarm?'D':b.warn!=null&&v>=b.warn?'C':'B';
const bandUnit=b=>b.qty==='acc'?'g':'mm/s';
function bandsFor(c){return c.bands&&c.bands.length?c.bands:null}
// Per-capture run speed: VFD machines estimate it from each capture (or use the RPM saved with it)
function speedOf(rec,dec,c){
  if(rec&&rec.rpm&&c.vfd)return rec.rpm/60;
  if(!c.vfd&&c.rpm)return c.rpm/60;
  if(rec&&rec.rpm)return rec.rpm/60;
  const d=dec?diagnose(dec,null,null,{}):null;return d&&d.f1||null;
}

// ---------- fault indicators, FASIT-like (A2) ----------
// Scores 0-10 from rules of thumb on the velocity spectrum, high-frequency acceleration,
// waveform kurtosis and envelope; an indication for screening, not a diagnosis.
function faultIndices(dec,c,f1){
  if(!dec||!f1)return null;
  const A=effLimits(c,'ov').alarm||7.1,sev=v=>Math.min(1,(v||0)/A),cl=v=>Math.max(0,Math.min(10,Math.round(v*10)/10));
  const V={};for(const a of['x','y','z'])V[a]=rawSpec(dec,'low','vel',a);
  if(!V.x.length)return null;
  const bin=V.x.length>1?V.x[1].x-V.x[0].x:1,tol=f=>Math.max(2*bin,f*0.02);
  const H=n=>({x:peakAt(V.x,n*f1,tol(n*f1)),y:peakAt(V.y,n*f1,tol(n*f1)),z:peakAt(V.z,n*f1,tol(n*f1))}),rad=h=>Math.max(h.x,h.z);
  const h1=H(1),h2=H(2),r1=rad(h1),r2=rad(h2),tot=Math.max(rssBand(V.x,0,1e9),rssBand(V.z,0,1e9))||1e-9;
  let harm=0;for(let n=3;n<=10;n++)if(rad(H(n))>=0.2*Math.max(r1,1e-9))harm++;
  const sub=Math.max(rad(H(0.5)),rad(H(1.5)),rad(H(2.5)));
  const why={},out={};
  out.unbalance=cl(10*sev(r1)*Math.min(1,r1/tot+0.2)*(h1.y<0.5*r1?1:0.6));why.unbalance=`1X แนวรัศมี ${r1.toFixed(2)} mm/s (${Math.round(r1/tot*100)}% ของทั้งหมด)`;
  const mis=Math.max(r2,h1.y);out.misalignment=cl(10*sev(mis)*Math.min(1,Math.max(r2,h1.y)/Math.max(r1,1e-9)));why.misalignment=`2X ${r2.toFixed(2)} · 1X แนวแกน ${h1.y.toFixed(2)} mm/s`;
  const r310=Math.max(rssBand(V.x,2.8*f1,10.2*f1),rssBand(V.z,2.8*f1,10.2*f1));
  out.looseness=cl(10*Math.min(1,harm/6+sub/Math.max(r1,1e-9))*Math.max(0.25,sev(r310*2)));why.looseness=`harmonics ${harm} ตัว · sub-harmonic ${sub.toFixed(2)} mm/s`;
  // bearing: HF acceleration, waveform kurtosis, envelope peaks at bearing frequencies
  let hiG=null,kurt=null,env=null;
  if(hasHigh(dec)){let q=0;for(const a of['x','y','z'])for(const p of rawSpec(dec,'high','acc',a))if(p.x>=1000)q+=p.y*p.y;hiG=Math.sqrt(q/3)}
  const T=(hasHigh(dec)&&dec.high.twf)||((dec.low||dec.single||{}).twf);
  if(T)kurt=Math.max(...['x','y','z'].map(a=>{const w=faWaveStats(T[a]||[]);return w?w.kurt:0}));
  const bf=bearingFreqs(f1,c.bearing),H2=hasHigh(dec)&&dec.high.twfSampleRate?dec.high:(dec.low||dec.single);
  if(bf&&H2&&H2.twf&&H2.twfSampleRate){const ny=H2.twfSampleRate/2;let best=0,bn='';
    for(const a of['x','y','z']){const e=envSpectrum(H2.twf[a],H2.twfSampleRate,ny*0.2,ny*0.9);if(!e)continue;
      const ys=e.pts.map(p=>p.y).sort((p,q)=>p-q),med=ys[Math.floor(ys.length/2)]||1e-12;
      for(const[k,f]of Object.entries(bf)){const r=peakAt(e.pts,f,Math.max(2*e.df,f*0.03))/med;if(r>best){best=r;bn=k}}}
    env={ratio:best,name:bn}}
  const sB=Math.max(hiG!=null?Math.min(1,hiG/2):0,kurt!=null?Math.min(1,Math.max(0,(kurt-3)/5)):0,env?Math.min(1,Math.max(0,(env.ratio-3)/20)):0);
  out.bearing=cl(10*sB);why.bearing=[hiG!=null?`HF ${hiG.toFixed(2)} g`:'',kurt!=null?`kurtosis ${kurt.toFixed(1)}`:'',env?`envelope ${env.name} ${env.ratio.toFixed(1)}× พื้น`:''].filter(Boolean).join(' · ');
  if(c.vanes){const vp=Math.max(rad(H(c.vanes)),H(c.vanes).y);out.flow=cl(10*sev(vp*1.5));why.flow=`vane pass ${c.vanes}X ${vp.toFixed(2)} mm/s`}
  const m=motorFreqs(f1,c),lf=(c.drive&&c.drive.lineHz)||50;
  let el=Math.abs(2*f1-2*lf)>3?Math.max(peakAt(V.x,2*lf,1),peakAt(V.z,2*lf,1)):0,pp=0;
  // pole-pass sidebands only when the spectrum resolves them (otherwise the 1X peak itself would match)
  if(m&&m.ppf>=2.5*bin){const t=bin*0.6;pp=Math.max(peakAt(V.x,f1-m.ppf,t),peakAt(V.x,f1+m.ppf,t),peakAt(V.z,f1-m.ppf,t),peakAt(V.z,f1+m.ppf,t))}
  out.electrical=cl(10*Math.max(sev(el*1.5),Math.min(1,pp/Math.max(r1,1e-9)*2)*sev(r1*2)));why.electrical=`2×LF ${el.toFixed(2)} mm/s${m?(m.ppf>=2.5*bin?` · pole-pass sideband ${pp.toFixed(2)}`:' · ความละเอียดไม่พอดู pole-pass'):''}`;
  return{scores:out,why};
}
const FAULT_LABEL={unbalance:'ไม่สมดุล',misalignment:'แนวเพลาไม่ตรง',looseness:'หลวม/ฐานไม่แน่น',bearing:'ตลับลูกปืน/หล่อลื่น',flow:'การไหล/ใบพัด',electrical:'ไฟฟ้า/มอเตอร์'};
function faultBarsHtml(fi){
  if(!fi)return'<p class="muted" style="margin:0">ต้องทราบความเร็วรอบ (RPM) ก่อน</p>';
  return`<div class="fbars">${Object.entries(fi.scores).map(([k,v])=>`<div class="fbar"><span>${FAULT_LABEL[k]}</span><div class="fbar-t"><i style="width:${v*10}%;background:var(${v>=6?'--zd':v>=3?'--zc':'--za'})"></i></div><b class="num">${v.toFixed(1)}</b><small class="muted">${esc(fi.why[k]||'')}</small></div>`).join('')}</div>
    <p class="muted fa-note" style="padding:6px 0 0">คะแนน 0–10 (≥3 เฝ้าระวัง, ≥6 ควรตรวจ) คำนวณจากกฎทั่วไปของการวิเคราะห์การสั่น เป็นตัวช่วยคัดกรอง ไม่ใช่ผลวินิจฉัย</p>`;
}

// ---------- reference spectrum + mask (A3) ----------
// mask(f) = max of the reference (all axes, ±3 bins) × multiplier, never below a floor
function refMask(refDec,c){
  const per=['x','y','z'].map(a=>rawSpec(refDec,'low','vel',a));if(!per[0].length)return null;
  const env=per[0].map((p,i)=>({x:p.x,y:Math.max(...per.map(s=>s[i]?s[i].y:0))}));
  const mul=c.maskMul||2,floor=c.maskFloor!=null?c.maskFloor:Math.max(0.1,0.05*(effLimits(c,'ov').warn||2.8));
  const m=env.map((p,i)=>{let y=0;for(let j=Math.max(0,i-3);j<=Math.min(env.length-1,i+3);j++)y=Math.max(y,env[j].y);return{x:p.x,y:Math.max(floor,y*mul)}});
  return m;
}
function maskAt(mask,f){let lo=0,hi=mask.length-1;while(hi-lo>1){const mid=(lo+hi)>>1;if(mask[mid].x<f)lo=mid;else hi=mid}return(Math.abs(mask[lo].x-f)<Math.abs(mask[hi].x-f)?mask[lo]:mask[hi]).y}
function maskExceed(dec,mask){
  if(!mask)return[];const out=[];
  for(const a of['x','y','z'])for(const p of rawSpec(dec,'low','vel',a)){const m=maskAt(mask,p.x);if(p.y>m)out.push({x:p.x,y:p.y,m,ax:a,r:p.y/m})}
  out.sort((p,q)=>q.r-p.r);const sel=[];for(const e of out){if(sel.every(s=>Math.abs(s.x-e.x)>3))sel.push(e);if(sel.length>=10)break}
  return sel;
}

// ---------- cursors (A4) ----------
// FA.cur = {mode:'off'|'harm'|'side'|'delta', pts:[Hz...]}
function cursorLines(k){
  const C=FA.cur||{},p=C.pts||[],L=[];
  if(C.mode==='harm'&&p[0])for(let n=1;n<=10;n++)L.push({x:n*p[0],label:n+'×',color:k.r});
  if(C.mode==='side'&&p[0]){L.push({x:p[0],label:'ศูนย์กลาง',color:k.r});if(p[1]){const d=Math.abs(p[1]-p[0]);for(let s=1;s<=5;s++)L.push({x:p[0]-s*d,label:'−'+s,color:k.r},{x:p[0]+s*d,label:'+'+s,color:k.r})}}
  if(C.mode==='delta'){p.forEach((x,i)=>L.push({x,label:i?'B':'A',color:k.r}))}
  return L;
}
function cursorInfo(f1){
  const C=FA.cur||{},p=C.pts||[],o=f=>f1?` (${(f/f1).toFixed(2)}X)`:'',cpm=f=>Math.round(f*60).toLocaleString('th-TH')+' CPM';
  if(C.mode==='harm'&&p[0])return`Harmonic cursor: ${p[0].toFixed(2)} Hz${o(p[0])} · ${cpm(p[0])}`;
  if(C.mode==='side'&&p[0])return p[1]?`Sideband: ศูนย์กลาง ${p[0].toFixed(2)} Hz · ระยะห่าง ${Math.abs(p[1]-p[0]).toFixed(2)} Hz${o(Math.abs(p[1]-p[0]))}`:`Sideband: ศูนย์กลาง ${p[0].toFixed(2)} Hz — คลิกยอดข้าง ๆ เพื่อกำหนดระยะห่าง`;
  if(C.mode==='delta'&&p[0])return p[1]?`Delta: A ${p[0].toFixed(2)} → B ${p[1].toFixed(2)} Hz · Δ ${Math.abs(p[1]-p[0]).toFixed(2)} Hz${o(Math.abs(p[1]-p[0]))} · ${cpm(Math.abs(p[1]-p[0]))}`:`Delta: A ${p[0].toFixed(2)} Hz — คลิกจุด B`;
  return C.mode&&C.mode!=='off'?'คลิกบนกราฟเพื่อวาง cursor (จะเกาะยอดที่ใกล้ที่สุด)':'';
}
function snapPeak(pts,f){
  if(!pts.length)return f;const bin=pts.length>1?pts[1].x-pts[0].x:1;let best=null;
  for(const p of pts)if(Math.abs(p.x-f)<=4*bin&&(!best||p.y>best.y))best=p;return best?best.x:f;
}
function cursorClick(f,pts){
  const C=FA.cur;if(!C||C.mode==='off')return false;f=snapPeak(pts,f);
  if(C.mode==='harm')C.pts=[f];
  else C.pts=C.pts.length>=2||!C.pts.length?[f]:[C.pts[0],f];
  return true;
}
// Automatic: harmonic families among the top peaks, and the best sideband spacing around the biggest peak
function findHarmonics(env,f1){
  const pk=faPeaks(env,25),top=pk.length?pk[0].y:0,bin=env.length>1?env[1].x-env[0].x:1,fams=[];
  const cands=[...pk.slice(0,10).map(p=>p.x),...(f1?[f1]:[])];
  for(const f0 of cands){let n=0;const hits=[];for(let h=1;h<=10;h++){const p=pk.find(q=>Math.abs(q.x-h*f0)<=Math.max(2*bin,h*f0*0.01)&&q.y>=0.05*top);if(p){n++;hits.push(h)}}
    if(n>=3&&!fams.some(F=>Math.abs(F.f0-f0)<2*bin))fams.push({f0,n,hits})}
  return fams.sort((a,b)=>b.n-a.n).slice(0,4);
}
function findSidebands(env,f1){
  const pk=faPeaks(env,30);if(pk.length<3)return null;const bin=env.length>1?env[1].x-env[0].x:1;
  const center=pk.find(p=>!f1||p.x>2.5*f1)||pk[0];let best=null;
  for(const p of pk){const d=Math.abs(p.x-center.x);if(d<3*bin)continue;let pairs=0;
    for(let s=1;s<=4;s++){const lo=pk.some(q=>Math.abs(q.x-(center.x-s*d))<=1.5*bin),hi=pk.some(q=>Math.abs(q.x-(center.x+s*d))<=1.5*bin);if(lo&&hi)pairs++;else if(s===1)break}
    if(pairs>=1&&(!best||pairs>best.pairs||(pairs===best.pairs&&d<best.d)))best={center:center.x,d,pairs}}
  return best;
}

// ---------- audio playback of the waveform (A7) ----------
let twfAudio=null;
function playTwf(dec,band,axis,speed){
  const B=dec.single||(band==='high'&&hasHigh(dec)?dec.high:dec.low);if(!B||!B.twf||!B.twfSampleRate)return toast('ไม่มี waveform');
  try{twfAudio&&twfAudio.stop()}catch(e){}
  const ctx=audioCtx||(audioCtx=new AudioContext()),src=B.twf[axis]||B.twf.x;
  let sp=speed||Math.max(1,Math.ceil(8000/B.twfSampleRate));
  const rate=Math.min(96000,Math.max(3000,B.twfSampleRate*sp));
  const peak=vmax(src.map(Math.abs))||1,mean=src.reduce((a,b)=>a+b,0)/src.length;
  const reps=Math.max(1,Math.ceil(3*rate/src.length)),buf=ctx.createBuffer(1,src.length*reps,rate),d=buf.getChannelData(0);
  for(let r=0;r<reps;r++)for(let i=0;i<src.length;i++){const w=Math.min(1,i/64,(src.length-i)/64);d[r*src.length+i]=(src[i]-mean)/peak*0.9*w}
  const n=ctx.createBufferSource();n.buffer=buf;n.connect(ctx.destination);n.start();twfAudio=n;
  toast(`กำลังเล่น waveform แกน ${axis.toUpperCase()} เร็ว ×${(rate/B.twfSampleRate).toFixed(0)} (${(buf.duration).toFixed(1)} วินาที)`);
}

// ---------- extra FFT-page modes (B2, B3, C1, C2) ----------
function fftReal(x,n){const re=new Float64Array(n),im=new Float64Array(n);for(let i=0;i<Math.min(n,x.length);i++)re[i]=x[i];fftC(re,im,false);return{re,im}}
function pow2(n){let p=1;while(p*2<=n)p*=2;return p}
function twfOf(dec){const B=FA.band==='high'&&hasHigh(dec)?dec.high:(dec.low||dec.single);return B&&B.twf&&B.twfSampleRate?B:null}
function lineDs(label,color,data,extra){return Object.assign({label,data,borderColor:color,backgroundColor:color,borderWidth:1.2,pointRadius:0,tension:0},extra)}
function xOpts(o,title,k,max){o.scales.x={type:'linear',min:0,max,title:{display:true,text:title,color:k.muted},ticks:{color:k.muted},grid:{color:k.line}};return o}

// Cepstrum: periodic families in the spectrum appear as peaks at their period (quefrency)
function faCeps(decA,decB,recA,recB,list,f1,c){
  const k=css(),B=twfOf(decA);if(!B){$('#faNote').textContent='ไม่มี waveform';$('#faSide').innerHTML='';return}
  const fs=B.twfSampleRate,n=pow2(B.twf.x.length),maxQ=Math.min(n/2,Math.round(fs*0.25)),ds=[];
  for(const a of faAxes()){const x=B.twf[a],m=x.reduce((p,q)=>p+q,0)/x.length,w=x.slice(0,n).map((v,i)=>(v-m)*(0.5-0.5*Math.cos(2*Math.PI*i/(n-1))));
    const{re,im}=fftReal(w,n);for(let i=0;i<n;i++){re[i]=Math.log(Math.hypot(re[i],im[i])+1e-9);im[i]=0}fftC(re,im,true);
    const pts=[];for(let q=2;q<maxQ;q++)pts.push({x:q/fs*1000,y:Math.abs(re[q])});ds.push(lineDs(AXES.find(z=>z[0]===a)[1],k[a],pts))}
  const L=[],bf=bearingFreqs(f1,c.bearing),qmax=maxQ/fs*1000;
  if(f1)for(let r=1;r<=4&&r*1000/f1<=qmax;r++)L.push({x:r*1000/f1,label:r>1?r+'×รอบ':'1 รอบ',color:k.muted});
  if(bf)for(const[nm,f]of Object.entries(bf))if(1000/f<=qmax)L.push({x:1000/f,label:nm,color:k.zd});
  const o=xOpts(opts('ค่า cepstrum'),'Quefrency (ms) = คาบเวลาของตระกูลยอด',k,qmax);o.plugins.faVlines={lines:L};
  o.plugins.tooltip.callbacks.title=it=>it.length?`${it[0].parsed.x.toFixed(2)} ms (= ${(1000/it[0].parsed.x).toFixed(1)} Hz)`:'';
  faCharts.push(new Chart($('#faChart'),{type:'line',data:{datasets:ds},options:o,plugins:[faVlines]}));
  $('#faNote').textContent='Cepstrum ช่วยหายอดที่มาเป็นตระกูล (harmonics/sidebands ระยะเท่ากัน) ยอดที่ตำแหน่ง 1 รอบหรือ 1/BPFO แปลว่ามีตระกูลของความถี่นั้นในสเปกตรัม';
  $('#faSide').innerHTML='';
}
function faAcorr(decA,decB,recA,recB,list,f1,c){
  const k=css(),B=twfOf(decA);if(!B){$('#faNote').textContent='ไม่มี waveform';$('#faSide').innerHTML='';return}
  const fs=B.twfSampleRate,N=B.twf.x.length,n=pow2(N)*2,ds=[];
  for(const a of faAxes()){const x=B.twf[a],m=x.reduce((p,q)=>p+q,0)/N;const{re,im}=fftReal(x.map(v=>v-m),n);
    for(let i=0;i<n;i++){re[i]=re[i]*re[i]+im[i]*im[i];im[i]=0}fftC(re,im,true);const r0=re[0]||1,pts=[];
    for(let l=0;l<N/2;l++)pts.push({x:l/fs*1000,y:re[l]/r0});ds.push(lineDs(AXES.find(z=>z[0]===a)[1],k[a],pts))}
  const L=[];if(f1)for(let r=1;r<=8&&r*1000/f1<N/2/fs*1000;r++)L.push({x:r*1000/f1,label:`รอบที่ ${r}`,color:k.muted});
  const o=xOpts(opts('ค่าสหสัมพันธ์ (−1…1)'),'ระยะเลื่อนเวลา (ms)',k,N/2/fs*1000);o.scales.y.beginAtZero=false;o.plugins.faVlines={lines:L};
  faCharts.push(new Chart($('#faChart'),{type:'line',data:{datasets:ds},options:o,plugins:[faVlines]}));
  $('#faNote').textContent='Autocorrelation: ยอดซ้ำเป็นจังหวะ = มีแรงกระแทกเกิดซ้ำทุกคาบนั้น (ตรงกับเส้นรอบเพลา = เกิดทุกรอบ เช่น ใบพัดเสียดสี / ไม่ตรงกับรอบ = มักเป็น bearing)';
  $('#faSide').innerHTML='';
}
function faCirc(decA,decB,recA,recB,list,f1,c){
  const k=css(),B=twfOf(decA);if(!B||!f1){$('#faNote').textContent=f1?'ไม่มี waveform':'ต้องทราบ RPM ก่อน';$('#faSide').innerHTML='';return}
  const fs=B.twfSampleRate,a=faAxes()[0],x=B.twf[a],m=x.reduce((p,q)=>p+q,0)/x.length,amp=vmax(x.map(v=>Math.abs(v-m)))||1;
  const spr=fs/f1,revs=Math.min(6,Math.floor(x.length/spr)),R0=amp*2.5,pal=[k.x,k.y,k.z,k.r,k.t,k.zb],ds=[];
  for(let r=0;r<revs;r++){const pts=[];for(let i=Math.floor(r*spr);i<=Math.floor((r+1)*spr)&&i<x.length;i++){const th=2*Math.PI*(i-r*spr)/spr-Math.PI/2,rr=R0+(x[i]-m);pts.push({x:rr*Math.cos(th),y:-rr*Math.sin(th)})}
    ds.push({label:'รอบที่ '+(r+1),data:pts,showLine:true,borderColor:pal[r],backgroundColor:pal[r],borderWidth:1,pointRadius:0})}
  const lim=R0+amp*1.1,o=opts('');o.scales={x:{type:'linear',min:-lim,max:lim,display:false},y:{min:-lim,max:lim,display:false}};o.aspectRatio=1;o.maintainAspectRatio=true;
  $('#faChart').parentElement.style.height='auto';
  faCharts.push(new Chart($('#faChart'),{type:'scatter',data:{datasets:ds},options:o}));
  $('#faNote').textContent=`Circular waveform แกน ${a.toUpperCase()}: แต่ละวง = 1 รอบเพลา (เริ่มที่ด้านบน หมุนตามเข็ม) · ถ้าแรงกระแทกเกิดที่มุมเดิมทุกรอบ = ปัญหาที่ผูกกับเพลา เช่น เพลาคด ใบพัดเสียดสี ข้อต่อ · ถ้ากระจายไม่เป็นที่ = มักเป็น bearing`;
  $('#faSide').innerHTML='';
}
// Spectrograph: one column per capture, colour = amplitude (log)
function faSgram(decA,decB,recA,recB,list,f1,c,range){
  const k=css(),recs=selRecs(list),axes=faAxes(),cols=[];
  for(const r of recs){const d=faDecode(r);if(!d)continue;cols.push({r,pts:faEnvelope(d,axes).filter(p=>p.x>=range.min&&p.x<=range.max)})}
  const host=$('#faChart').parentElement;host.innerHTML='<canvas id="faSg" style="width:100%;height:100%;cursor:crosshair"></canvas>';
  const cv_=$('#faSg'),W=cv_.clientWidth||800,H=cv_.clientHeight||420,dpr=devicePixelRatio||1;cv_.width=W*dpr;cv_.height=H*dpr;
  const g=cv_.getContext('2d');g.scale(dpr,dpr);const L=60,R=12,T=10,Bm=34,pw=W-L-R,ph=H-T-Bm;
  let mx=0,mn=Infinity;cols.forEach(cl=>cl.pts.forEach(p=>{if(p.y>0){mx=Math.max(mx,p.y);mn=Math.min(mn,p.y)}}));
  const lo=Math.log10(Math.max(mn,mx/1e3)),hi=Math.log10(mx||1);
  const ramp=t=>{t=Math.max(0,Math.min(1,t));const s=[[13,8,135],[126,3,168],[204,71,120],[248,149,64],[240,249,33]],i=Math.min(3,Math.floor(t*4)),f=t*4-i,a=s[i],b=s[i+1];return`rgb(${a.map((v,j)=>Math.round(v+(b[j]-v)*f)).join(',')})`};
  g.fillStyle='#0d0887';g.fillRect(L,T,pw,ph);
  const cw=pw/Math.max(1,cols.length);
  cols.forEach((cl,i)=>cl.pts.forEach(p=>{const y=T+ph-(p.x-range.min)/(range.max-range.min)*ph;g.fillStyle=ramp((Math.log10(Math.max(p.y,1e-12))-lo)/(hi-lo||1));g.fillRect(L+i*cw,y-1.5,Math.ceil(cw),3)}));
  g.fillStyle=k.muted;g.font='11px "IBM Plex Sans Thai",sans-serif';
  for(let j=0;j<=5;j++){const f=range.min+(range.max-range.min)*j/5,y=T+ph-j/5*ph;g.fillText(f.toFixed(0)+' Hz',4,y+4)}
  cols.forEach((cl,i)=>{if(cols.length<=12||i%Math.ceil(cols.length/10)===0)g.fillText(dShort(cl.r.ts*1000),L+i*cw,H-14)});
  cv_.style.touchAction='none';
  cv_.onpointermove=cv_.onpointerdown=e=>{const b=cv_.getBoundingClientRect(),i=Math.floor((e.clientX-b.left-L)/cw),f=range.min+(T+ph-(e.clientY-b.top))/ph*(range.max-range.min);const cl=cols[i];
    if(!cl||f<range.min||f>range.max)return;const p=cl.pts.reduce((a,q)=>Math.abs(q.x-f)<Math.abs(a.x-f)?q:a,cl.pts[0]);
    $('#faNote').textContent=`${dFull(cl.r.ts*1000)} · ${p.x.toFixed(1)} Hz · ${faFmt(p.y)} ${faUnit()}`};
  $('#faNote').textContent=`Spectrograph ${cols.length} ชุด (เก่า → ใหม่ จากซ้ายไปขวา) สีเหลือง = สูง · ชี้หรือแตะเพื่อดูค่า · เส้นแนวนอนที่สว่างขึ้นเรื่อย ๆ = ยอดที่โตขึ้น`;
  $('#faSide').innerHTML='';
}
// Bump test: natural frequencies from a capture taken while the machine was stopped and struck
function faBump(decA,decB,recA,recB,list,f1,c,range){
  const k=css(),per=['x','y','z'].map(a=>rawSpec(decA,'low','acc',a)),env=per[0].map((p,i)=>({x:p.x,y:Math.max(...per.map(s=>s[i]?s[i].y:0))})).filter(p=>p.x>=2);
  const ds=faAxes().map(a=>lineDs(AXES.find(z=>z[0]===a)[1],k[a],rawSpec(decA,'low','acc',a).filter(p=>p.x>=2)));
  const nat=faPeaks(env,8).filter(p=>p.y>0).sort((a,b)=>a.x-b.x);
  const ops=[];if(f1){ops.push(['1X',f1],['2X',2*f1]);if(c.vanes)ops.push(['vane pass',c.vanes*f1])}ops.push(['ไฟ 2×LF',2*((c.drive&&c.drive.lineHz)||50)]);
  const L=nat.map((p,i)=>({x:p.x,label:'fn'+(i+1),color:k.zd})).concat(ops.map(([n,f])=>({x:f,label:n,color:k.muted})));
  const o=faChartOpts('g',range);o.plugins.faVlines={lines:L};
  faCharts.push(new Chart($('#faChart'),{type:'line',data:{datasets:ds},options:o,plugins:[faVlines]}));
  const risk=nat.map(p=>{const near=ops.filter(([,f])=>Math.abs(p.x-f)/f<=0.1);return{p,near}});
  $('#faNote').textContent='Bump test: ใช้ชุดที่วัดตอนเครื่องหยุดแล้วเคาะตัวเครื่อง ยอดที่เด่นคือความถี่ธรรมชาติ (fn) ถ้า fn ใกล้ความถี่ทำงาน ±10% เสี่ยงสั่นพ้อง (resonance)';
  $('#faSide').innerHTML=`<div class="panel"><div class="ph"><h3>ความถี่ธรรมชาติที่พบ</h3><label class="check" style="font-size:12.5px"><input type="checkbox" id="bumpTag" ${recA.tag==='bump'?'checked':''}> ชุดนี้เป็น bump test</label></div>
    <div class="tablewrap"><table><thead><tr><th>#</th><th>Hz</th><th>CPM</th><th>g</th><th>ใกล้ความถี่ทำงาน</th></tr></thead><tbody>
    ${risk.map((r,i)=>`<tr><td>fn${i+1}</td><td class="num">${r.p.x.toFixed(1)}</td><td class="num">${Math.round(r.p.x*60)}</td><td class="num">${r.p.y.toFixed(4)}</td><td>${r.near.length?`<span class="tag zD">เสี่ยง: ${r.near.map(n=>n[0]).join(', ')}</span>`:'<span class="tag zB">ห่างพอ</span>'}</td></tr>`).join('')||'<tr><td colspan="5" class="muted">ไม่พบยอด</td></tr>'}</tbody></table></div></div>
    <div class="panel pbody"><div class="sub-h">วิธีทำ bump test ด้วย i-ALERT3</div><ol style="margin:4px 0 0;padding-left:20px;font-size:13px">
      <li>หยุดเครื่อง (ล็อกเอาต์ให้ปลอดภัย) แต่เซนเซอร์ยังติดอยู่ที่เดิม</li><li>เชื่อมต่อเซนเซอร์ แล้วกด "สั่งวัด FFT ใหม่" ในหน้าภาพรวม</li>
      <li>ทันทีที่สถานะขึ้น "เซนเซอร์เริ่มวัด" ใช้ค้อนยาง/ไม้เคาะตัวเครื่องใกล้เซนเซอร์เป็นระยะ ๆ ทุก 1–2 วินาที จนวัดเสร็จ</li>
      <li>เปิดชุดนั้นในโหมด Bump test แล้วติ๊ก "ชุดนี้เป็น bump test"</li></ol>
      <p class="muted" style="font-size:12px;margin:6px 0 0">หมายเหตุ: ยังไม่ได้ยืนยันว่าช่วงเวลาวัดของ i-ALERT3 ยาวพอสำหรับการเคาะ ถ้าไม่เห็นยอดชัดให้ลองเคาะถี่ขึ้น</p></div>`;
  $('#bumpTag').onchange=async e=>{recA.tag=e.target.checked?'bump':null;await FFTDB.put(recA);toast('บันทึกแล้ว')};
}
// 3D motion of the sensor point at one frequency (band-pass of the three waveforms)
let motionAnim=null;
function faMotion(decA,decB,recA,recB,list,f1,c){
  const k=css(),B=twfOf(decA);if(!B){$('#faNote').textContent='ไม่มี waveform';$('#faSide').innerHTML='';return}
  const fs=B.twfSampleRate,n=pow2(B.twf.x.length),f=FA.motionF||f1||null;
  if(!f){$('#faNote').textContent='ใส่ RPM หรือความถี่ที่ต้องการดูก่อน';return}
  const filt=a=>{const x=B.twf[a],m=x.reduce((p,q)=>p+q,0)/x.length;const{re,im}=fftReal(x.map(v=>v-m),n),df=fs/n,kc=Math.round(f/df);
    const amp=Math.hypot(re[kc],im[kc])*2/n,ph=Math.atan2(im[kc],re[kc]);
    for(let i=0;i<n;i++){const kk=i<=n/2?i:n-i;if(Math.abs(kk-kc)>1){re[i]=0;im[i]=0}}fftC(re,im,true);return{s:Array.from(re.slice(0,Math.min(n,Math.round(fs/f*3)))),amp,ph}};
  const X=filt('x'),Y=filt('y'),Z=filt('z'),g2mm=v=>v*9806.65/(2*Math.PI*f)*1000/(2*Math.PI*f); // g → µm (displacement)
  const orbit=X.s.map((v,i)=>({x:Z.s[i],y:v}));
  const lim=Math.max(...orbit.map(p=>Math.max(Math.abs(p.x),Math.abs(p.y))))*1.15||1;
  const o=opts('X (Vertical)');o.scales={x:{type:'linear',min:-lim,max:lim,title:{display:true,text:'Z (Horizontal)',color:k.muted},ticks:{display:false},grid:{color:k.line}},y:{min:-lim,max:lim,title:{display:true,text:'X (Vertical)',color:k.muted},ticks:{display:false},grid:{color:k.line}}};
  o.aspectRatio=1;o.maintainAspectRatio=true;$('#faChart').parentElement.style.height='auto';
  faCharts.push(new Chart($('#faChart'),{type:'scatter',data:{datasets:[{label:`วงโคจร X–Z ที่ ${f.toFixed(1)} Hz`,data:orbit,showLine:true,borderColor:k.x,backgroundColor:k.x,borderWidth:1.6,pointRadius:0}]},options:o}));
  const dphi=(a,b)=>{let d=(a.ph-b.ph)*180/Math.PI;while(d>180)d-=360;while(d<-180)d+=360;return d};
  $('#faNote').textContent=`การเคลื่อนที่ของจุดติดเซนเซอร์ที่ ${f.toFixed(1)} Hz (กรองเฉพาะความถี่นี้) · ถือว่า 3 แกนของเซนเซอร์สุ่มพร้อมกัน — ยังไม่ได้ยืนยันกับ i-ALERT3 จริง ใช้ดูทิศการสั่นโดยประมาณ ไม่ใช่ ODS ทั้งเครื่อง`;
  $('#faSide').innerHTML=`<div class="panel"><div class="ph"><h3>แอนิเมชัน 3 มิติ (ขยายให้เห็น)</h3><label class="fa-rpm" style="font-size:12px">ความถี่ <input type="number" id="mF" step="any" value="${f.toFixed(2)}" style="width:80px"> Hz</label></div><canvas id="m3d" style="width:100%;height:260px"></canvas></div>
    <div class="panel"><div class="ph"><h3>ขนาดและเฟสที่ ${f.toFixed(1)} Hz</h3></div><div class="tablewrap"><table><thead><tr><th>แกน</th><th>ความเร่ง (g)</th><th>การกระจัด (µm)</th><th>เฟสเทียบ X</th></tr></thead><tbody>
    ${[['X',X],['Y',Y],['Z',Z]].map(([n,v])=>`<tr><td>${n}</td><td class="num">${v.amp.toFixed(4)}</td><td class="num">${g2mm(v.amp).toFixed(1)}</td><td class="num">${n==='X'?'0°':dphi(v,X).toFixed(0)+'°'}</td></tr>`).join('')}</tbody></table></div>
    <p class="muted fa-note">เฟสต่างกันเกือบ 0° หรือ 180° = สั่นเป็นเส้นตรงทิศเดียว · ใกล้ ±90° = สั่นเป็นวง (เช่น unbalance มักเป็นวงรี)</p></div>`;
  $('#mF').onchange=e=>{FA.motionF=+e.target.value||null;renderFFTPage()};
  const cv_=$('#m3d'),W=cv_.clientWidth||400,H=260,dpr=devicePixelRatio||1;cv_.width=W*dpr;cv_.height=H*dpr;const g=cv_.getContext('2d');g.scale(dpr,dpr);
  const mxA=vmax([X,Y,Z].flatMap(v=>v.s.map(Math.abs)))||1,S=Math.min(W,H)*0.32/mxA,cx=W/2,cy=H/2;
  const proj=(x,y,z)=>[cx+(z-y)*0.866*S,cy-(x)*S+(z+y)*0.5*S*0.6];
  cancelAnimationFrame(motionAnim);let t=0;
  const draw=()=>{if(!document.body.contains(cv_)||cv_.offsetParent===null||FA.mode!=='motion'||S.view!=='fft')return;g.clearRect(0,0,W,H);g.lineWidth=1;
    [[1,0,0,'X',k.x],[0,1,0,'Y',k.y],[0,0,1,'Z',k.z]].forEach(([a,b,cc,l,col])=>{const[x0,y0]=proj(0,0,0),[x1,y1]=proj(a*mxA,b*mxA,cc*mxA);g.strokeStyle=col;g.globalAlpha=.5;g.beginPath();g.moveTo(x0,y0);g.lineTo(x1,y1);g.stroke();g.globalAlpha=1;g.fillStyle=col;g.fillText(l,x1+3,y1)});
    g.strokeStyle=k.muted;g.globalAlpha=.35;g.beginPath();X.s.forEach((_,i)=>{const[px,py]=proj(X.s[i],Y.s[i],Z.s[i]);i?g.lineTo(px,py):g.moveTo(px,py)});g.stroke();g.globalAlpha=1;
    const i=t%X.s.length,[px,py]=proj(X.s[i],Y.s[i],Z.s[i]);g.fillStyle=k.zd;g.beginPath();g.arc(px,py,6,0,7);g.fill();
    t+=Math.max(1,Math.round(X.s.length/180));motionAnim=requestAnimationFrame(draw)};
  draw();
}

// ---------- spectrum / time-signal CSV import (B8: e.g. exported from Adash DDS or another analyzer) ----------
function importFftCsv(file,asset,unit){
  return file.text().then(text=>{
    const rows=parseCSV(text);if(rows.length<4)throw new Error('ไฟล์สั้นเกินไป');
    const hdr=rows[0].map(h=>h.toLowerCase());let start=1;
    if(rows[0].every(v=>!isNaN(parseFloat(v)))){start=0}
    const col0=hdr[0]||'',isTime=/time|เวลา|\bs\b|ms|sec/.test(col0)&&!/freq|hz/.test(col0);
    const ms=/ms|millis/.test(col0);
    const data=rows.slice(start).map(r=>r.map(v=>parseFloat(String(v).replace(',','.')))).filter(r=>r.length>1&&r.every(Number.isFinite));
    if(data.length<8)throw new Error('อ่านตัวเลขได้น้อยเกินไป');
    const nAx=Math.min(3,data[0].length-1),axes=['x','y','z'],x0=data.map(r=>r[0]);
    const zeros=()=>new Float64Array(data.length);
    let band;
    if(isTime){ // waveform → spectrum
      const dt=(x0[1]-x0[0])*(ms?1e-3:1),fs=1/dt,toG=v=>unit==='ms2'?v/9.80665:v;
      const twf={};axes.forEach((a,i)=>twf[a]=i<nAx?data.map(r=>toG(r[i+1])):data.map(()=>0));
      const n=pow2(data.length),hz=fs/n,gf={x:[],y:[],z:[]},vf={x:[],y:[],z:[]},freq=[];
      for(let i=0;i<n/2;i++)freq.push(i*hz);
      for(const a of axes){const w=twf[a].slice(0,n).map((v,i)=>v*(0.5-0.5*Math.cos(2*Math.PI*i/(n-1))));const{re,im}=fftReal(w,n);
        for(let i=0;i<n/2;i++){const g=Math.hypot(re[i],im[i])*4/n/Math.SQRT2;gf[a].push(g);vf[a].push(i?g*9806.65/(2*Math.PI*i*hz):0)}}
      band={freq,gfft:gf,vfft:vf,twf,hzPerBin:hz,startBin:1,endBin:n/2-1,twfSampleRate:fs};
    }else{ // spectrum
      const conv={mms:v=>v,ips:v=>v*25.4,g:v=>v,ms2:v=>v/9.80665}[unit];const isVel=unit==='mms'||unit==='ips';
      const freq=x0,hz=freq.length>1?freq[1]-freq[0]:1,gf={},vf={};
      axes.forEach((a,i)=>{const col=i<nAx?data.map(r=>conv(r[i+1])):data.map(()=>0);
        if(isVel){vf[a]=col;gf[a]=col.map((v,j)=>v*2*Math.PI*freq[j]/9806.65)}else{gf[a]=col;vf[a]=col.map((g,j)=>freq[j]>0?g*9806.65/(2*Math.PI*freq[j]):0)}});
      band={freq,gfft:gf,vfft:vf,twf:null,hzPerBin:hz,startBin:1,endBin:freq.length-1,twfSampleRate:null};
    }
    const ts=Math.floor((file.lastModified||Date.now())/1000);
    const rec={key:`${asset}|i|${ts}|${file.name}`,asset,ts,kind:'import',src:file.name,dec:{single:band},bytes:new Uint8Array(0)};
    return FFTDB.put(rec).then(()=>rec);
  });
}

// ---------- Bands + fault indicators mode (A1 + A2) ----------
function faBands(decA,decB,recA,recB,list,f1,c){
  const k=css();
  if(!c.bands||!c.bands.length){c.bands=defaultBands();save()}
  const B=c.bands,recs=selRecs(list);
  const rows=recs.map(r=>{const d=faDecode(r);if(!d)return null;const f=speedOf(r,d,c)||f1;
    return{r,vals:B.map(b=>{const v=bandValue(d,b,f);return v?v.v:null}),fi:faultIndices(d,c,f)}}).filter(Boolean);
  const pal=[k.x,k.y,k.z,k.r,k.t,k.zb,k.zc,k.zd,k.muted];
  const ds=B.map((b,i)=>({label:b.name+' ('+bandUnit(b)+')',data:rows.filter(x=>x.vals[i]!=null).map(x=>({x:x.r.ts*1000,y:x.vals[i]})),borderColor:pal[i%pal.length],backgroundColor:pal[i%pal.length],borderWidth:1.6,pointRadius:3,tension:.2,yAxisID:b.qty==='acc'?'y2':'y'}));
  const o=opts('mm/s',{y2:{position:'right',title:{display:true,text:'g',color:k.muted},ticks:{color:k.muted},grid:{display:false}}});
  faCharts.push(new Chart($('#faChart'),{type:'line',data:{datasets:ds},options:o}));
  $('#faNote').textContent=`แนวโน้มค่าแต่ละแถบความถี่ข้าม FFT ${rows.length} ชุด (ค่ารวมแบบ RMS ในแถบ ของแกนที่สูงสุด)${c.vfd?' · เครื่อง VFD: ใช้รอบของแต่ละชุด':''}`;
  const cur=faDecode(recA),fCur=speedOf(recA,cur,c)||f1,fi=faultIndices(cur,c,fCur);
  // change vs the capture just before the selected one (not always the second newest)
  const rowsByT=rows.slice().sort((x,y)=>x.r.ts-y.r.ts),ai_=rowsByT.findIndex(x=>x.r.key===recA.key),prevRow=ai_>0?rowsByT[ai_-1]:null;
  const cell=v=>v==null?'':v;
  $('#faSide').innerHTML=`
    <div class="panel" style="grid-column:1/-1"><div class="ph"><h3>Bands report · ${dFull(recA.ts*1000)}</h3>
      <div class="row"><button class="btn sm" id="bdAuto" title="ใช้ชุดอ้างอิง (หรือชุดที่เลือก) × 2 = เตือน, × 4 = อันตราย">ตั้งเกณฑ์อัตโนมัติจากชุดอ้างอิง</button>
      ${c.bearing&&bearingFreqs(1,c.bearing)?'<button class="btn sm" id="bdBrg">+ แถบ bearing</button>':''}<button class="btn sm" id="bdAdd">+ เพิ่มแถบ</button><button class="btn sm" id="bdReset">คืนค่าเริ่มต้น</button></div></div>
      <div class="tablewrap" style="max-height:none"><table class="bands-t"><thead><tr><th>ชื่อแถบ</th><th>จาก</th><th>ถึง</th><th>หน่วยช่วง</th><th>ปริมาณ</th><th>ค่าล่าสุด</th><th>เตือน</th><th>อันตราย</th><th>สถานะ</th><th>เทียบชุดก่อน</th><th></th></tr></thead><tbody>
      ${B.map((b,i)=>{const v=bandValue(cur,b,fCur),z=bandZone(b,v&&v.v),prev=prevRow?prevRow.vals[i]:null,ch=v&&prev?((v.v-prev)/prev*100):null;
        return`<tr data-i="${i}"><td><input class="bN" value="${esc(b.name)}"></td><td><input type="number" step="any" class="bLo" value="${b.lo}"></td><td><input type="number" step="any" class="bHi" value="${b.hi}"></td>
          <td><select class="bU"><option value="X" ${b.unit==='X'?'selected':''}>× รอบ</option><option value="Hz" ${b.unit==='Hz'?'selected':''}>Hz</option></select></td>
          <td><select class="bQ"><option value="vel" ${b.qty==='vel'?'selected':''}>Velocity</option><option value="acc" ${b.qty==='acc'?'selected':''}>Acc (g)</option></select></td>
          <td class="num">${v?v.v.toFixed(3)+' '+bandUnit(b)+' ('+v.ax.toUpperCase()+')':'–'}</td>
          <td><input type="number" step="any" class="bW" value="${cell(b.warn)}"></td><td><input type="number" step="any" class="bA" value="${cell(b.alarm)}"></td>
          <td>${z?`<span class="tag z${z}">${z==='D'?'อันตราย':z==='C'?'เตือน':'ปกติ'}</span>`:''}</td><td class="num ${ch>20?'up':''}">${ch==null?'–':(ch>=0?'+':'')+ch.toFixed(0)+'%'}</td>
          <td><button class="btn sm danger bDel">ลบ</button></td></tr>`}).join('')}</tbody></table></div>
      <p class="muted fa-note">ช่วง "× รอบ" คำนวณจาก RPM (${fCur?Math.round(fCur*60)+' RPM':'ยังไม่ทราบ'}) · ค่าในแถบ = RMS ของยอดในช่วงนั้น · แจ้งเตือนอัตโนมัติเมื่อได้ FFT ชุดใหม่ที่เกินเกณฑ์</p></div>
    <div class="panel"><div class="ph"><h3>ดัชนีความผิดปกติ (แบบ FASIT)</h3></div><div class="pbody">${faultBarsHtml(fi)}</div></div>
    <div class="panel"><div class="ph"><h3>แนวโน้มดัชนีความผิดปกติ</h3></div><div class="cbox"><canvas id="fiTrend"></canvas></div></div>`;
  if(rows.some(x=>x.fi)){const keys=Object.keys(rows.find(x=>x.fi).fi.scores);const q=opts('คะแนน 0–10');q.scales.y.max=10;
    faCharts.push(new Chart($('#fiTrend'),{type:'line',data:{datasets:keys.map((kk,i)=>({label:FAULT_LABEL[kk],data:rows.filter(x=>x.fi).map(x=>({x:x.r.ts*1000,y:x.fi.scores[kk]})),borderColor:pal[i],backgroundColor:pal[i],borderWidth:1.5,pointRadius:2}))},options:q}))}
  document.querySelectorAll('.bands-t tr[data-i]').forEach(tr=>{const b=B[+tr.dataset.i],num=s=>{const v=tr.querySelector(s).value;return v===''?null:+v};
    tr.querySelectorAll('input,select').forEach(el=>el.onchange=()=>{Object.assign(b,{name:tr.querySelector('.bN').value,lo:num('.bLo'),hi:num('.bHi'),unit:tr.querySelector('.bU').value,qty:tr.querySelector('.bQ').value,warn:num('.bW'),alarm:num('.bA')});
      b.src=b.qty==='acc'&&b.unit==='Hz'&&b.lo>=1000?'high':'low';save();renderFFTPage()});
    tr.querySelector('.bDel').onclick=()=>{c.bands=B.filter(x=>x!==b);save();renderFFTPage()}});
  $('#bdAdd').onclick=()=>{B.push({id:uid(),name:'แถบใหม่',lo:1,hi:2,unit:'X',qty:'vel',src:'low'});save();renderFFTPage()};
  $('#bdReset').onclick=()=>{if(confirm('คืนแถบความถี่เป็นค่าเริ่มต้น? (เกณฑ์ที่ตั้งไว้จะหายไป)')){c.bands=defaultBands();save();renderFFTPage()}};
  if($('#bdBrg'))$('#bdBrg').onclick=()=>{const bf=bearingFreqs(1,c.bearing);for(const[n,fac]of Object.entries(bf))if(n!=='FTF')B.push({id:uid(),name:n+' ±5% (velocity)',lo:+(fac*0.95).toFixed(3),hi:+(fac*1.05).toFixed(3),unit:'X',qty:'vel',src:'low'});save();renderFFTPage()};
  $('#bdAuto').onclick=()=>{const ref=(c.refFft&&list.find(r=>r.key===c.refFft))||recA,d=faDecode(ref),f=speedOf(ref,d,c)||f1;
    B.forEach(b=>{const v=bandValue(d,b,f);if(!v)return;const fl=b.qty==='acc'?0.05:0.2;b.warn=+Math.max(fl,v.v*2).toFixed(3);b.alarm=+Math.max(fl*2,v.v*4).toFixed(3)});
    save();renderFFTPage();toast(`ตั้งเกณฑ์จากชุด ${dFull(ref.ts*1000)} แล้ว`)};
}

// ---------- new-capture checks: band alarms, mask, fault indices -> notification ----------
async function onFftSaved(rec){
  appLog('data',`ได้ FFT ใหม่ (${KIND_LABEL[rec.kind||'alarm']||rec.kind}) · ${rec.asset} · วัดเมื่อ ${dFull(rec.ts*1000)}`);
  try{
    const c=cfg(rec.asset),d=faDecode(rec);if(!d)return;const f1=speedOf(rec,d,c),msgs=[];
    (c.bands||[]).forEach(b=>{const v=bandValue(d,b,f1),z=v&&bandZone(b,v.v);if(z==='C'||z==='D')msgs.push(`${b.name} ${v.v.toFixed(2)} ${bandUnit(b)} (${z==='D'?'อันตราย':'เตือน'})`)});
    if(c.refFft&&c.refFft!==rec.key){const list=await FFTDB.list(rec.asset),ref=list.find(r=>r.key===c.refFft),rd=ref&&faDecode(ref);
      if(rd){const ex=maskExceed(d,refMask(rd,c));if(ex.length)msgs.push(`เกินเส้นอ้างอิง ${ex.length} ยอด (สูงสุด ${ex[0].x.toFixed(1)} Hz ×${ex[0].r.toFixed(1)})`)}}
    const fi=faultIndices(d,c,f1);if(fi)Object.entries(fi.scores).forEach(([kk,v])=>{if(v>=6)msgs.push(`ดัชนี${FAULT_LABEL[kk]} ${v.toFixed(1)}/10`)});
    if(msgs.length)notify(rec.asset+'|fft|'+rec.key,'🔎 FFT ใหม่ของ '+rec.asset,msgs.join(' · '),rec.asset);
  }catch(e){console.warn('onFftSaved',e)}
}

// ---------- 3D waterfall (drag to rotate, wheel / buttons for height) ----------
// Spectra are drawn back-to-front as filled ridges, so nearer captures hide the ones behind.
FA.wf={az:-0.55,el:0.55,h:1};
function faWaterfallMode(...a){return FA.wf2d?faWaterfall(...a):faWaterfall3D(...a)}
function faWaterfall3D(decA,decB,recA,recB,list,f1,c,range){
  wfMountPicker(list,24);
  const k=css(),axes=faAxes(),recs=wfRecs(list,24),series=[];
  for(const r of recs){const d=faDecode(r);if(!d)continue;
    const pts=faEnvelope(d,axes).filter(p=>p.x>=range.min&&p.x<=range.max);
    const n=500,step=Math.max(1,Math.ceil(pts.length/n)),red=[];
    for(let i=0;i<pts.length;i+=step){let m=pts[i];for(let j=i;j<Math.min(pts.length,i+step);j++)if(pts[j].y>m.y)m=pts[j];red.push(m)}
    series.push({r,pts:red})}
  const host=$('#faChart').parentElement;host.innerHTML='<canvas id="faW3" style="width:100%;height:100%;cursor:grab;touch-action:none"></canvas>';
  const cv_=$('#faW3'),W=cv_.clientWidth||800,H=cv_.clientHeight||420,dpr=devicePixelRatio||1;cv_.width=W*dpr;cv_.height=H*dpr;
  const g=cv_.getContext('2d');g.scale(dpr,dpr);
  let top=0;series.forEach(s=>s.pts.forEach(p=>{if(p.y>top)top=p.y}));top=top||1;
  const nS=Math.max(1,series.length-1),fr=range.max-range.min||1;
  const marks=faMarkers(f1,c,range.max).filter(m=>m.x>=range.min&&m.x<=range.max&&m.label);
  const lerp=(a,b,t)=>a+(b-a)*t;
  const hex=s=>{const m=s.trim().match(/^#?([0-9a-f]{6})$/i);if(!m)return[120,140,160];const v=parseInt(m[1],16);return[v>>16&255,v>>8&255,v&255]};
  const cOld=hex(k.muted),cNew=hex(k.x);
  const draw=()=>{
    const{az,el,h}=FA.wf,ca=Math.cos(az),sa=Math.sin(az),se=Math.sin(el),ce=Math.cos(el);
    const S=Math.min(W*0.62,H*1.1),cx=W*0.5,cy=H*0.62;
    // world: x 0..1 (freq), z 0..1 (time, 0 = oldest at back), y 0..1 (amplitude)
    const P=(x,y,z)=>{const X=x-0.5,Z=0.5-z,xr=X*ca-Z*sa,zr=X*sa+Z*ca;return[cx+xr*S,cy-y*h*S*0.55*ce+zr*S*0.55*se,zr]};
    g.clearRect(0,0,W,H);g.font='11px "IBM Plex Sans Thai",sans-serif';g.lineWidth=1;
    // floor grid + marker lines
    g.strokeStyle=k.line;g.fillStyle=k.muted;
    for(let i=0;i<=5;i++){const x=i/5,[a1,b1]=P(x,0,0),[a2,b2]=P(x,0,1);g.beginPath();g.moveTo(a1,b1);g.lineTo(a2,b2);g.stroke();
      const[tx,ty]=P(x,0,1);g.fillText((range.min+fr*x).toFixed(0)+' Hz',tx-14,ty+14)}
    for(const z of[0,1]){const[a1,b1]=P(0,0,z),[a2,b2]=P(1,0,z);g.beginPath();g.moveTo(a1,b1);g.lineTo(a2,b2);g.stroke()}
    for(const m of marks){const x=(m.x-range.min)/fr,[a1,b1]=P(x,0,0),[a2,b2]=P(x,0,1);g.strokeStyle=m.color;g.globalAlpha=.55;g.setLineDash([4,3]);g.beginPath();g.moveTo(a1,b1);g.lineTo(a2,b2);g.stroke();g.setLineDash([]);g.globalAlpha=1;g.fillStyle=m.color;g.fillText(m.label,a1+2,b1-3)}
    // amplitude axis at the back-left corner
    const[ax0,ay0]=P(0,0,0),[ax1,ay1]=P(0,1,0);g.strokeStyle=k.muted;g.beginPath();g.moveTo(ax0,ay0);g.lineTo(ax1,ay1);g.stroke();
    g.fillStyle=k.muted;for(let i=1;i<=4;i++){const[tx,ty]=P(0,i/4,0);g.fillText(faFmt(top*i/4/(h||1)*h),tx-46,ty+4)}g.fillText(faUnit(),ax1-10,ay1-6);
    // ridges back-to-front
    const order=series.map((s,i)=>({s,i,z:P(0.5,0,nS?i/nS:0)[2]})).sort((a,b)=>b.z-a.z);
    for(const{s,i}of order){const z=nS?i/nS:0,t=series.length>1?i/(series.length-1):1;
      const col=`rgb(${cOld.map((v,j)=>Math.round(lerp(v,cNew[j],t))).join(',')})`;
      g.beginPath();const[sx,sy]=P(0,0,z);g.moveTo(sx,sy);
      for(const p of s.pts){const[px,py]=P((p.x-range.min)/fr,p.y/top,z);g.lineTo(px,py)}
      const[ex,ey]=P(1,0,z);g.lineTo(ex,ey);g.closePath();
      g.fillStyle=getComputedStyle(document.body).backgroundColor;g.globalAlpha=.88;g.fill();g.globalAlpha=1;
      g.strokeStyle=col;g.lineWidth=i===series.length-1?1.8:1.1;g.stroke();
      if(series.length<=12||i%Math.ceil(series.length/8)===0||i===series.length-1){const[lx,ly]=P(1,0,z);g.fillStyle=col;const nt=fftNote(s.r.key);g.fillText(dShort(s.r.ts*1000)+(nt?' · '+(nt.length>18?nt.slice(0,18)+'…':nt):''),lx+6,ly+4)}}
  };
  draw();
  // interaction: drag rotates, wheel changes height
  let drag=null;
  cv_.onpointerdown=e=>{drag={x:e.clientX,y:e.clientY,az:FA.wf.az,el:FA.wf.el};cv_.setPointerCapture(e.pointerId);cv_.style.cursor='grabbing'};
  cv_.onpointermove=e=>{if(!drag)return;FA.wf.az=drag.az+(e.clientX-drag.x)*0.008;FA.wf.el=Math.max(0.05,Math.min(1.4,drag.el+(e.clientY-drag.y)*0.006));draw()};
  cv_.onpointerup=cv_.onpointercancel=()=>{drag=null;cv_.style.cursor='grab'};
  cv_.onwheel=e=>{e.preventDefault();FA.wf.h=Math.max(0.2,Math.min(4,FA.wf.h*(e.deltaY<0?1.12:0.89)));draw()};
  $('#faNote').textContent=`Waterfall 3 มิติ: ${series.length} ชุด (เก่าอยู่หลัง ใหม่อยู่หน้า สีเข้มขึ้น) · ลากเพื่อหมุนมุมมอง · หมุนล้อเมาส์หรือปุ่มด้านล่างเพื่อปรับความสูง`;
  $('#faSide').innerHTML=`<div class="panel pbody" style="grid-column:1/-1"><div class="row">
    <div class="seg" id="wfMode"><button data-v="3d" class="on">3D</button><button data-v="2d">2D</button></div>
    <button class="btn sm" id="wfUp">ยอดสูงขึ้น</button><button class="btn sm" id="wfDn">ยอดต่ำลง</button>
    <button class="btn sm" data-view="front">มุมหน้า</button><button class="btn sm" data-view="side">มุมเฉียง</button><button class="btn sm" data-view="top">มุมบน</button></div></div>`;
  $('#wfUp').onclick=()=>{FA.wf.h=Math.min(4,FA.wf.h*1.25);draw()};$('#wfDn').onclick=()=>{FA.wf.h=Math.max(0.2,FA.wf.h/1.25);draw()};
  const views={front:{az:0,el:0.35},side:{az:-0.55,el:0.55},top:{az:-0.2,el:1.25}};
  document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{Object.assign(FA.wf,views[b.dataset.view]);draw()});
  document.querySelectorAll('#wfMode button').forEach(b=>b.onclick=()=>{FA.wf2d=b.dataset.v==='2d';renderFFTPage()});
}
