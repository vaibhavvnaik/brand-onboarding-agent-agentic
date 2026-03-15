#!/usr/bin/env bash
set -euo pipefail
cd /home/vnaik/urklist/brand-onboarding-agent
node - <<'NODE'
const fs=require('fs');
require('dotenv').config();
const mongoose=require('mongoose');
const baselinePath='artifacts/flagged-half-screenshots-full-2026-03-12T17-16-59-945Z.json';
const oldCsv='artifacts/old-flagged-links-live.csv';
const newCsv='artifacts/new-retaken-links-live.csv';
const compareCsv='artifacts/before-after-links-live.csv';
function q(v){return '"'+String(v??'').replace(/"/g,'""')+'"';}
(async()=>{
  const baseline=JSON.parse(fs.readFileSync(baselinePath,'utf8'));
  const rows=baseline.rows||[];
  const oldLines=['rank,title,messageId,updatedAt,oldScreenshotUrl'];
  rows.forEach((r,i)=>oldLines.push([i+1,q(r.title),q(r.messageId),q(r.updatedAt||''),q(r.screenshotUrl||'')].join(',')));
  fs.writeFileSync(oldCsv, oldLines.join('\n'));
  await mongoose.connect(process.env.MONGODB_URI);
  const col=mongoose.connection.db.collection('Listing');
  const ids=[...new Set(rows.map(r=>String(r.messageId||'')).filter(Boolean))];
  const cur=await col.find({messageId:{$in:ids}},{projection:{title:1,messageId:1,content:1,screenshotRetakenAt:1,updatedAt:1}}).toArray();
  const curMap=new Map(cur.map(r=>[String(r.messageId),r]));
  const newLines=['rank,title,messageId,currentUpdatedAt,screenshotRetakenAt,newScreenshotUrl,status'];
  const cmpLines=['rank,title,messageId,oldScreenshotUrl,newScreenshotUrl,changed,screenshotRetakenAt'];
  rows.forEach((r,i)=>{const m=curMap.get(String(r.messageId||'')); const newUrl=m?.content||''; const oldUrl=r.screenshotUrl||''; const changed=newUrl&&oldUrl&&newUrl!==oldUrl?'yes':(newUrl===oldUrl?'no':'missing'); const status=m?(m.screenshotRetakenAt?'retaken':'not_retaken'):'not_found';
    newLines.push([i+1,q(m?.title||r.title||''),q(r.messageId||''),q(m?.updatedAt?new Date(m.updatedAt).toISOString():''),q(m?.screenshotRetakenAt?new Date(m.screenshotRetakenAt).toISOString():''),q(newUrl),q(status)].join(','));
    cmpLines.push([i+1,q(m?.title||r.title||''),q(r.messageId||''),q(oldUrl),q(newUrl),q(changed),q(m?.screenshotRetakenAt?new Date(m.screenshotRetakenAt).toISOString():'')].join(','));
  });
  fs.writeFileSync(newCsv, newLines.join('\n'));
  fs.writeFileSync(compareCsv, cmpLines.join('\n'));
  const retaken=rows.filter(r=>!!curMap.get(String(r.messageId||''))?.screenshotRetakenAt).length;
  console.log(JSON.stringify({baseline:rows.length,retaken,oldCsv,newCsv,compareCsv},null,2));
  await mongoose.disconnect();
})();
NODE
