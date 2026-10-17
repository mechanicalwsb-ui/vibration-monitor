// Storage for the dashboard: small settings in localStorage, large collections in IndexedDB,
// plus full backup/restore (including FFT captures). Loaded before the dashboard script; uses its
// globals at call time (S, KEY, FFTDB, toast, render, APP_VERSION, esc).

// Collections that grow without limit live in IndexedDB (localStorage holds ~5 MB in total)
const BIGKEYS=['readings','maint','health','ai','failures'];
const VDB={
  db:null,
  open(){return this.db||(this.db=new Promise((res,rej)=>{
    const q=indexedDB.open('vibmon-data',1);
    q.onupgradeneeded=()=>q.result.createObjectStore('kv');
    q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)}))},
  async get(k){const db=await this.open();return new Promise((res,rej)=>{
    const q=db.transaction('kv').objectStore('kv').get(k);q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)})},
  async put(k,v){const db=await this.open();return new Promise((res,rej)=>{
    const t=db.transaction('kv','readwrite');t.objectStore('kv').put(v,k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error)})}
};
const store={idb:false,timer:null,writing:null,err:null};

// Small part: everything except BIGKEYS (and anything starting with "_", which is runtime-only)
function smallState(){const o={};for(const k in S)if(!BIGKEYS.includes(k)&&k[0]!=='_')o[k]=S[k];return o}
function persistBig(now){
  clearTimeout(store.timer);
  const run=async()=>{
    try{for(const k of BIGKEYS)await VDB.put(k,S[k]);store.err=null}
    catch(e){store.err=e;console.error(e);toast('บันทึกข้อมูลลงเครื่องไม่สำเร็จ: '+e.message)}
  };
  if(now)return store.writing=run();
  store.timer=setTimeout(()=>{store.writing=run()},400);
}
function saveState(){
  if(typeof gdMarkDirty==='function')try{gdMarkDirty()}catch(e){}
  if(!store.idb){ // IndexedDB unavailable (e.g. some private modes): everything in localStorage as before
    const all=smallState();for(const k of BIGKEYS)all[k]=S[k];
    try{localStorage.setItem(KEY,JSON.stringify(all))}
    catch(e){toast('บันทึกในเบราว์เซอร์ไม่ได้ (พื้นที่เต็ม) ควรสำรองข้อมูลและเปิดในเบราว์เซอร์ปกติ')}
    return;
  }
  try{localStorage.setItem(KEY,JSON.stringify(smallState()))}catch(e){toast('บันทึกค่าตั้งค่าไม่ได้: '+e.message)}
  persistBig();
}
// Flush pending writes when the tab is hidden or closed (tablets often kill background tabs)
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&store.idb&&store.timer)persistBig(true)});

async function loadState(){
  let j=null;try{j=JSON.parse(localStorage.getItem(KEY)||'null')}catch(e){}
  if(j)Object.assign(S,j);
  try{
    await VDB.open();store.idb=true;
    const legacy=j&&Array.isArray(j.readings)&&j.readings.length; // data saved by v1.11 and older
    if(legacy){
      // Move readings to IndexedDB; only drop them from localStorage once the copy reads back complete
      await persistBig(true);
      const back=await VDB.get('readings');
      if(back&&back.length===S.readings.length){localStorage.setItem(KEY,JSON.stringify(smallState()));console.info('moved',back.length,'readings to IndexedDB')}
      else throw new Error('ตรวจสอบการย้ายข้อมูลไม่ผ่าน');
    }else{
      for(const k of BIGKEYS){const v=await VDB.get(k);if(v!=null)S[k]=v}
    }
  }catch(e){store.idb=false;console.warn('IndexedDB unavailable, using localStorage',e)}
  for(const k of BIGKEYS)if(S[k]==null)S[k]=k==='health'||k==='ai'?{}:[];
  // Ask the browser not to evict our data when the device runs low on space
  try{if(navigator.storage&&navigator.storage.persist&&!(await navigator.storage.persisted()))store.persisted=await navigator.storage.persist();else store.persisted=true}catch(e){}
}
async function storageInfo(){
  try{const e=await navigator.storage.estimate();return{used:e.usage,quota:e.quota}}catch(e){return null}
}
const fmtBytes=b=>b==null?'–':b>=1e9?(b/1e9).toFixed(1)+' GB':b>=1e6?(b/1e6).toFixed(1)+' MB':Math.max(1,Math.round(b/1e3))+' KB';

// ---- backup / restore ----
function b64(u8){let s='';for(let i=0;i<u8.length;i+=0x8000)s+=String.fromCharCode.apply(null,u8.subarray(i,i+0x8000));return btoa(s)}
function unb64(s){const b=atob(s),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}
function download(name,blob){
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}
async function exportBackup(){
  let fft=[];try{fft=await FFTDB.all()}catch(e){}
  const state={};for(const k in S)if(k[0]!=='_')state[k]=S[k];
  const data={format:'vibmon-backup',version:1,exportedAt:new Date().toISOString(),app:APP_VERSION,
    state,fft:fft.map(r=>({...r,bytes:b64(r.bytes)}))};
  const d=new Date(),ymd=`${d.getFullYear()+543}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  download(`vibmon-backup-${ymd}.json`,new Blob([JSON.stringify(data)],{type:'application/json'}));
  S.lastBackup=Date.now();save();
  toast(`สำรองข้อมูลแล้ว: ${S.readings.length.toLocaleString('th-TH')} ค่า · FFT ${fft.length} ชุด`);
  if(S.view==='settings')render();
}
// mode 'merge' = add what is missing; 'replace' = this backup becomes the whole state
async function importBackup(file,mode){
  let data;
  try{data=JSON.parse(await file.text())}catch(e){return toast('ไฟล์นี้ไม่ใช่ไฟล์สำรอง (อ่าน JSON ไม่ได้)')}
  if(!data||data.format!=='vibmon-backup'||!data.state)return toast('ไฟล์นี้ไม่ใช่ไฟล์สำรองของ Vibration Monitor');
  const st=data.state,fft=(data.fft||[]).map(r=>({...r,bytes:unb64(r.bytes)}));
  if(mode==='replace'){
    if(!confirm(`แทนที่ข้อมูลทั้งหมดในเครื่องนี้ด้วยไฟล์สำรอง?\n\nไฟล์: ${(st.readings||[]).length} ค่า · FFT ${fft.length} ชุด (สำรองเมื่อ ${new Date(data.exportedAt).toLocaleString('th-TH')})\nข้อมูลปัจจุบัน: ${S.readings.length} ค่า จะถูกลบ`))return;
    for(const k of Object.keys(S))delete S[k];
    Object.assign(S,{readings:[],assets:{},unit:'mm',tunit:'C',sel:null,range:30,sensors:{},maint:[],health:{},ai:{},failures:[]},st);
    await FFTDB.clear();for(const r of fft)await FFTDB.put(r);
    save();persistBig(true);render();
    return toast(`กู้คืนแล้ว ${S.readings.length.toLocaleString('th-TH')} ค่า · FFT ${fft.length} ชุด`);
  }
  const{nR,nF}=await mergeState(st,fft);
  save();persistBig(true);render();
  toast(`รวมข้อมูลแล้ว: เพิ่ม ${nR.toLocaleString('th-TH')} ค่า · FFT ${nF} ชุด`);
}
function pickBackupFile(mode){
  const i=document.createElement('input');i.type='file';i.accept='.json,application/json';
  i.onchange=()=>{if(i.files[0])importBackup(i.files[0],mode)};i.click();
}
const backupDue=()=>S.readings.length>0&&Date.now()-(S.lastBackup||0)>7*864e5;

// Move readings of one machine in a time range to another name (to separate data from two sensors
// that were saved under the same machine name)
function moveReadings(from,to,t0,t1){
  let n=0;const have=new Set(S.readings.filter(r=>r.asset===to).map(r=>r.t));
  S.readings=S.readings.filter(r=>{
    if(r.asset!==from||r.t<t0||r.t>t1)return true;
    n++;if(have.has(r.t))return false;r.asset=to;return true});
  if(n){cfg(to);save()}
  return n;
}

// ---- Raspberry Pi gateway (gateway/ia3-gateway.js): pull its data and merge ----
// The gateway serves this page itself (http://<pi>:8080/), so the default address is this page's own
// folder. A page opened over https (GitHub Pages) cannot read an http:// gateway (browser blocks it).
const gwBase=()=>{const u=(S.gw&&S.gw.url)||'';return u?u.replace(/\/?$/,'/'):''};
async function gatewayStatus(base){
  try{const r=await fetch(base+'api/status',{cache:'no-store'});if(!r.ok)return null;const j=await r.json();return j&&j.gateway?j:null}catch(e){return null}
}
async function gatewaySync(quiet){
  const base=gwBase();
  if(location.protocol==='https:'&&/^http:/.test(base)){if(!quiet)toast('หน้าเว็บ https เปิดข้อมูลจาก Gateway แบบ http ไม่ได้ ให้เปิดหน้าเว็บจาก Gateway โดยตรง');return}
  try{
    const r=await fetch(base+'api/backup',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);
    const text=await r.text();
    S.gw=Object.assign(S.gw||{},{last:Date.now()});
    await importBackup(new File([text],'gateway.json'),'merge');
  }catch(e){if(!quiet)toast('ดึงข้อมูลจาก Gateway ไม่ได้: '+e.message)}
}

// ---- merging state from another device (backup file, gateway, Google Drive) ----
// Deletes and renames are remembered as tombstones, so data removed or merged on one device does not
// come back from another: S.tomb = {assets:{name:deletedAt}, maint:[ids], failures:[ids]}, S.renames = {from:to}
function tomb(){return S.tomb||(S.tomb={assets:{},maint:[],failures:[]})}
// renames: {from:{to,t}} (older files: {from:"to"}, treated as oldest). Applied oldest first, and renaming
// X→Y drops any earlier Y→… so merging back and forth on two devices never leaves a loop that keeps both names.
function normRenames(...lists){
  const all=[];for(const l of lists)for(const[f,v]of Object.entries(l||{}))all.push([f,typeof v==='string'?v:v.to,typeof v==='string'?0:(v.t||0)]);
  all.sort((a,b)=>a[2]-b[2]);const out={};
  for(const[f,to,t]of all){if(!to||f===to)continue;delete out[to];out[f]={to,t}}
  return out;
}
function finalName(a,ren){const seen=new Set();while(ren[a]&&!seen.has(a)){seen.add(a);const v=ren[a];a=typeof v==='string'?v:v.to}return a}
async function mergeState(st,fft){
  const ren=normRenames(st.renames,S.renames);S.renames=ren;
  const tb=tomb(),rt=st.tomb||{};
  for(const[a,t]of Object.entries(rt.assets||{}))tb.assets[a]=Math.max(tb.assets[a]||0,t);
  tb.maint=[...new Set([...(tb.maint||[]),...(rt.maint||[])])];tb.failures=[...new Set([...(tb.failures||[]),...(rt.failures||[])])];
  const fix=a=>finalName(a,ren),dead=(a,t)=>tb.assets[a]!=null&&t<=tb.assets[a];
  // apply renames/deletes that arrived from the other device to local data too
  for(const r of S.readings)r.asset=fix(r.asset);
  S.readings=S.readings.filter(r=>!dead(r.asset,r.t));
  const idx=new Map(S.readings.map((r,i)=>[r.asset+'|'+r.t,i]));let nR=0;
  for(const r0 of st.readings||[]){const r={...r0,asset:fix(r0.asset)};if(dead(r.asset,r.t))continue;const k=r.asset+'|'+r.t;
    if(!idx.has(k)){idx.set(k,S.readings.length);S.readings.push(r);nR++}
    else{const ex=S.readings[idx.get(k)];if(ex.live&&!r.live){Object.assign(ex,r);delete ex.live}}}
  for(const[a0,c]of Object.entries(st.assets||{})){const a=fix(a0);if(!S.assets[a]&&!dead(a,Infinity))S.assets[a]=c;else if(S.assets[a])for(const[k,v]of Object.entries(c))if(S.assets[a][k]==null)S.assets[a][k]=v}
  for(const k of Object.keys(S.assets))if(fix(k)!==k){const t=fix(k);S.assets[t]=Object.assign({},S.assets[k],S.assets[t]||{});delete S.assets[k]}
  for(const[id,sv]of Object.entries(st.sensors||{})){if(!S.sensors[id])S.sensors[id]=sv;else{const m=S.sensors[id];m.names=[...new Set([...(m.names||[]),...(sv.names||[])])];if(!m.mac&&sv.mac)m.mac=sv.mac}}
  for(const sv of Object.values(S.sensors))sv.asset=fix(sv.asset);
  const mIds=new Set((S.maint||[]).map(m=>m.id));for(const m of st.maint||[])if(!mIds.has(m.id))S.maint.push({...m,asset:fix(m.asset)});
  S.maint=S.maint.filter(m=>!tb.maint.includes(m.id)).map(m=>({...m,asset:fix(m.asset)}));
  for(const[k,list]of Object.entries(st.health||{})){
    const cur=S.health[k]||(S.health[k]=[]),ts=new Set(cur.map(h=>h.t));
    for(const h of list)if(!ts.has(h.t))cur.push(h);cur.sort((a,b)=>a.t-b.t);
  }
  S.ai=S.ai||{};for(const[a0,list]of Object.entries(st.ai||{})){const a=fix(a0),cur=S.ai[a]||(S.ai[a]=[]),ids=new Set(cur.map(h=>h.id));for(const h of list)if(!ids.has(h.id))cur.push(h)}
  {S.failures=S.failures||[];const ids=new Map(S.failures.map(f=>[f.id,f]));
    for(const f of st.failures||[]){const ex=ids.get(f.id);if(!ex)S.failures.push({...f,asset:fix(f.asset)});else if((f.mt||0)>(ex.mt||0))Object.assign(ex,f,{asset:fix(f.asset)})}
    S.failures=S.failures.filter(f=>!tb.failures.includes(f.id))}
  if(st.brgDb)S.brgDb=Object.assign({},st.brgDb,S.brgDb||{});
  if(st.routes){S.routes=S.routes||[];const ids=new Set(S.routes.map(r=>r.id));for(const r of st.routes)if(!ids.has(r.id))S.routes.push(r)}
  if(st.fav)S.fav=[...new Set([...(S.fav||[]),...st.fav].map(fix))];
  let nF=0;
  if(fft&&fft.length){const have=new Set((await FFTDB.all()).map(r=>r.key));
    for(const r of fft){const a=fix(r.asset);if(dead(a,r.ts*1000))continue;const key=a===r.asset?r.key:a+r.key.slice(r.asset.length);
      if(!have.has(key)){await FFTDB.put({...r,asset:a,key});have.add(key);nF++}}}
  if(S.sel)S.sel=fix(S.sel);
  return{nR,nF};
}
