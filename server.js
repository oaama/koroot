const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),QR=require('qrcode');
const DB=process.env.DB||path.join(__dirname,'data.json');
let db=fs.existsSync(DB)?JSON.parse(fs.readFileSync(DB)):{cafes:{},cards:{}};
const save=()=>fs.writeFileSync(DB,JSON.stringify(db));
const id=n=>crypto.randomBytes(n).toString('hex');
const day=864e5;
function send(res,code,obj,type='application/json'){res.writeHead(code,{'content-type':type+'; charset=utf-8'});res.end(typeof obj==='string'?obj:JSON.stringify(obj));}
function body(req){return new Promise(r=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{r(JSON.parse(b||'{}'))}catch{r({})}})})}
const norm=p=>String(p||'').replace(/[^\d]/g,'').replace(/^00/,'');
const pubCard=(c,cafe)=>({id:c.id,name:c.name,phone:c.phone,stamps:c.stamps,free:c.free,visits:c.visits.length,last:c.visits.at(-1)||null,need:cafe.need,reward:cafe.reward,cafe:{name:cafe.name,slug:cafe.slug,lat:cafe.lat,lng:cafe.lng}});
function auth(cafe,req,b){return (req.headers['x-pin']||b.pin)===cafe.pin;}
http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://x');const p=u.pathname;let m;
 try{
 if(p.startsWith('/api/')){
  const b=req.method==='POST'?await body(req):{};
  if(p==='/api/cafes'&&req.method==='POST'){
   if(!b.name||!/^\d{4,8}$/.test(b.pin||''))return send(res,400,{error:'الاسم والرقم السري (4 إلى 8 أرقام) مطلوبين'});
   let slug=b.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'cafe';
   while(db.cafes[slug])slug=slug.split('-')[0]+'-'+id(2);
   db.cafes[slug]={slug,name:b.name,pin:b.pin,need:+b.need||6,reward:b.reward||'قهوة مجانًا',lat:b.lat||null,lng:b.lng||null,winbackDays:14,created:Date.now()};save();
   return send(res,200,{slug});}
  if(m=p.match(/^\/api\/qr$/)){const s=await QR.toString(u.searchParams.get('t')||'',{type:'svg',margin:1,color:{dark:'#1c3d2e',light:'#0000'}});return send(res,200,s,'image/svg+xml');}
  if(m=p.match(/^\/api\/card\/([a-f0-9]+)$/)){const c=db.cards[m[1]];if(!c)return send(res,404,{error:'الكارت غير موجود'});return send(res,200,pubCard(c,db.cafes[c.cafe]));}
  if(m=p.match(/^\/api\/cafe\/([\w-]+)(?:\/(\w+))?$/)){
   const cafe=db.cafes[m[1]];if(!cafe)return send(res,404,{error:'الكافيه غير موجود'});const act=m[2];
   if(!act)return send(res,200,{name:cafe.name,slug:cafe.slug,need:cafe.need,reward:cafe.reward});
   if(act==='join'){const ph=norm(b.phone);if(ph.length<8||!b.name)return send(res,400,{error:'اكتب الاسم ورقم الموبايل'});
    let c=Object.values(db.cards).find(c=>c.cafe===cafe.slug&&c.phone===ph);
    if(!c){c={id:id(5),cafe:cafe.slug,name:b.name.trim(),phone:ph,stamps:0,free:0,visits:[],joined:Date.now()};db.cards[c.id]=c;save();}
    return send(res,200,{id:c.id});}
   if(!auth(cafe,req,b))return send(res,401,{error:'الرقم السري غير صحيح'});
   if(act==='login')return send(res,200,{ok:true,name:cafe.name});
   if(act==='find'){const q=String(b.q||'').trim();const ph=norm(q);const c=db.cards[q]||Object.values(db.cards).find(c=>c.cafe===cafe.slug&&(c.phone===ph||c.phone.endsWith(ph)&&ph.length>=6));
    if(!c||c.cafe!==cafe.slug)return send(res,404,{error:'مفيش عميل بالكود أو الرقم ده'});return send(res,200,pubCard(c,cafe));}
   if(act==='stamp'||act==='redeem'){const c=db.cards[b.id];if(!c||c.cafe!==cafe.slug)return send(res,404,{error:'الكارت غير موجود'});
    if(act==='stamp'){const last=c.visits.at(-1);if(last&&Date.now()-last<3*60e3)return send(res,429,{error:'تم ختم الكارت من أقل من 3 دقائق'});
     c.visits.push(Date.now());c.stamps++;if(c.stamps>=cafe.need){c.stamps-=cafe.need;c.free++;}}
    else{if(c.free<1)return send(res,400,{error:'مفيش مكافأة جاهزة'});c.free--;c.redeemed=(c.redeemed||0)+1;}
    save();return send(res,200,pubCard(c,cafe));}
   if(act==='admin'){const cs=Object.values(db.cards).filter(c=>c.cafe===cafe.slug);const now=Date.now();
    const list=cs.map(c=>({...pubCard(c,cafe),days:c.visits.length?Math.floor((now-c.visits.at(-1))/day):null,redeemed:c.redeemed||0}));
    const week=cs.reduce((a,c)=>a+c.visits.filter(v=>now-v<7*day).length,0);
    return send(res,200,{cafe:{name:cafe.name,slug:cafe.slug,need:cafe.need,reward:cafe.reward,winbackDays:cafe.winbackDays,lat:cafe.lat,lng:cafe.lng},stats:{customers:cs.length,visitsWeek:week,free:cs.reduce((a,c)=>a+c.free,0),redeemed:cs.reduce((a,c)=>a+(c.redeemed||0),0)},list});}
   if(act==='settings'){if(b.need)cafe.need=Math.max(3,Math.min(12,+b.need));if(b.reward)cafe.reward=b.reward;if(b.winbackDays)cafe.winbackDays=+b.winbackDays;if('lat'in b){cafe.lat=b.lat;cafe.lng=b.lng}save();return send(res,200,{ok:true});}
  }
  return send(res,404,{error:'not found'});
 }
 let f=path.join(__dirname,'public',p==='/'||!path.extname(p)?'app.html':p);
 if(!f.startsWith(path.join(__dirname,'public'))||!fs.existsSync(f))return send(res,404,'not found','text/plain');
 const t={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json','.png':'image/png'}[path.extname(f)]||'application/octet-stream';
 res.writeHead(200,{'content-type':t+'; charset=utf-8'});res.end(fs.readFileSync(f));
 }catch(e){send(res,500,{error:String(e)});}
}).listen(process.env.PORT||3000,()=>console.log('koroot on',process.env.PORT||3000));
