// Offline support + notification clicks.
// Own files: network first (updates arrive as soon as they are online), cached copy when offline.
// Libraries and fonts from CDNs: cache first (versioned URLs never change).
const CACHE='vibmon-2.16.0'; // stamped by deploy.sh: every release installs fresh and drops the old cache
const CORE=['./','./index.html','./ia3-fft.js','./fft-analysis.js','./store.js','./activity.js','./insights.js','./pages.js','./ai.js','./tools.js','./machine.js','./machine-setup.js','./machine-level.js','./gdrive.js','./site-config.js','./manifest.json','./icon-192.png','./icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js','https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>Promise.all(CORE.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const req=e.request;if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin===location.origin){
    // revalidate with the server every time (GitHub Pages lets browsers reuse files for 10 minutes)
    e.respondWith(fetch(req.url,{cache:'no-cache',credentials:'same-origin'}).then(res=>{
      if(res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy))}
      return res;
    }).catch(async()=>{
      // offline: the exact file first (same ?v= as the page), then any copy of it; the page itself only for navigations
      const hit=await caches.match(req)||await caches.match(req,{ignoreSearch:true});
      if(hit)return hit;
      if(req.mode==='navigate')return caches.match('./index.html');
      return new Response('',{status:504,statusText:'offline'});
    }));
  }else if(/cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.host)){
    e.respondWith(caches.match(req).then(hit=>hit||fetch(req).then(res=>{
      const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy));return res})));
  }
});
// Tapping a notification focuses the dashboard and opens that machine
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const asset=e.notification.data&&e.notification.data.asset;
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    const c=list[0];
    if(c){c.focus();if(asset)c.postMessage({asset});return}
    return self.clients.openWindow('./'+(asset?'#asset='+encodeURIComponent(asset):''));
  }));
});
