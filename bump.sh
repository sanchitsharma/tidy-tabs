#!/bin/sh
# Bump the extension patch version and stamp the update time, so an open popup auto-reloads
# (dev-reload.js) and shows "vX.Y.Z · updated <time>". Usage: ./bump.sh
set -e
cd "$(dirname "$0")/extension"
node -e '
const fs=require("fs");const m=JSON.parse(fs.readFileSync("manifest.json","utf8"));
const p=m.version.split(".").map(Number);p[2]++;m.version=p.join(".");
const d=new Date(),z=n=>String(n).padStart(2,"0");
m.version_name=`${m.version} (${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())})`;
fs.writeFileSync("manifest.json",JSON.stringify(m,null,2)+"\n");console.log(m.version_name);'
