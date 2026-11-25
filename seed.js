// Sample data for local preview: node seed.js (writes data.json)
const fs=require('fs'),d=864e5,n=Date.now();const cards={};let i=0;
const mk=(name,phone,stamps,free,days,visits)=>{const id=('a1b2c3d4e'+(i++)+'0000000000').slice(0,10);cards[id]={id,cafe:'qahwet-elrokn',name,phone,stamps,free,redeemed:free?0:1,joined:n-30*d,visits:Array.from({length:visits},(_,k)=>n-days*d-(visits-1-k)*3*d)};};
mk('كريم','01011112222',4,0,1,10);mk('منى','01099887766',2,1,3,8);mk('أحمد','01222334455',1,0,19,3);mk('سارة','01155667788',3,0,16,9);mk('يوسف','01033445566',5,0,0,11);mk('هدى','01277889900',0,0,25,2);
fs.writeFileSync(process.env.DB||'data.json',JSON.stringify({cafes:{'qahwet-elrokn':{slug:'qahwet-elrokn',name:'قهوة الركن',pin:'1234',need:6,reward:'قهوة مجانًا',lat:30.0444,lng:31.2357,winbackDays:14,created:n}},cards}));
