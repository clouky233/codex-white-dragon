const assert=require('node:assert/strict'),fs=require('node:fs');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const exec=promisify(execFile),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function nativeRegion(hwnd,points){
 const script=`Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DragonRegionCheck {
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr window, IntPtr region);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
 [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
 [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr region,int x,int y);
 [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
}
'@
[void][DragonRegionCheck]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$region=[DragonRegionCheck]::CreateRectRgn(0,0,0,0)
try {
 $window=[IntPtr]::new(${hwnd})
 $kind=[DragonRegionCheck]::GetWindowRgn($window,$region)
 $factor=[DragonRegionCheck]::GetDpiForWindow($window)/96.0
 $points='${JSON.stringify(points)}' | ConvertFrom-Json
 $values=@($points | ForEach-Object { [PSCustomObject]@{ name=$_.name; inside=[DragonRegionCheck]::PtInRegion($region,[int][Math]::Round($_.x*$factor),[int][Math]::Round($_.y*$factor)); expected=$_.expected } })
 [PSCustomObject]@{kind=$kind;factor=$factor;points=$values} | ConvertTo-Json -Depth 4 -Compress
} finally { [void][DragonRegionCheck]::DeleteObject($region) }`;
 const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000});return JSON.parse(stdout.trim());
}
module.exports=async({widget,settings,applyWindow,placeWidget,getHitRegion,persist,reportFile})=>{
 const original=structuredClone(settings),originalBounds=widget.getBounds();const report={cases:[],native:[]};
 try{
  assert.equal(await widget.webContents.executeJavaScript('document.getElementById("quota-bubble").hidden'),true,'quota bubble must be hidden when the widget starts');
  async function checkRegion(scale,phase,cssPoints){
   const points=cssPoints.map(p=>({...p,x:p.x*scale,y:p.y*scale}));
   const handle=widget.getNativeWindowHandle().readBigUInt64LE().toString();
   const native=await nativeRegion(handle,points);
   report.native.push({scale,phase,cssPoints,points,region:getHitRegion(),...native});
   assert.ok(native.kind>0,'Windows must have a nonrectangular region');
   for(const p of native.points)assert.equal(p.inside,p.expected,`Windows hit region ${p.name} ${phase} at scale ${scale}`);
  }
  for(const scale of [.65,1,1.4]){
   settings.scale=scale;applyWindow();await delay(160);const wanted={width:Math.round(370*scale),height:Math.round(570*scale)};let maxWidth=0,maxHeight=0;
   for(let i=0;i<240;i++){placeWidget(60+i%41,8+i%23);const b=widget.getBounds();maxWidth=Math.max(maxWidth,b.width);maxHeight=Math.max(maxHeight,b.height);assert.ok(Math.abs(b.width-wanted.width)<=3&&Math.abs(b.height-wanted.height)<=3,'window must not grow with consecutive moves');}
   await delay(160);report.cases.push({scale,moves:240,wanted,after:widget.getBounds(),maxWidth,maxHeight});
   await widget.webContents.executeJavaScript('window.dragonHitRegion.refresh()');await delay(120);assert.ok(getHitRegion().length>10,'native shape must contain the actual rendered regions');
   const dragonPoints=await widget.webContents.executeJavaScript(`(()=>{const r=document.getElementById('dragon').getBoundingClientRect();return [{name:'transparent-window-corner',x:3,y:3,expected:false},{name:'transparent-bottom',x:innerWidth/2,y:innerHeight-3,expected:false},{name:'transparent-sprite-corner',x:r.x+3,y:r.y+3,expected:false},{name:'dragon-solid-face',x:r.x+r.width*.5,y:r.y+r.height*.6,expected:true}]})()`);
   // Hidden descendants have zero DOM bounds. Briefly lay out the bubble to
   // locate its controls, then restore the default hidden state before probing.
   const bubblePoints=await widget.webContents.executeJavaScript(`(()=>{showQuotaBubble();const c=document.getElementById('quota-bubble').getBoundingClientRect(),b=document.getElementById('settings').getBoundingClientRect();const points=[{name:'quota-card',x:c.x+c.width/2,y:c.y+30,expected:true},{name:'settings-button',x:b.x+b.width/2,y:b.y+b.height/2,expected:true}];hideQuotaBubble();return points;})()`);
   await delay(120);
   await checkRegion(scale,'default-hidden',[...dragonPoints,...bubblePoints.map(p=>({...p,expected:false}))]);
   // This suite tests native geometry. Keep the bubble open while a separate
   // PowerShell process inspects its HWND; timing is covered by the UI test.
   await widget.webContents.executeJavaScript('showQuotaBubble();clearTimeout(bubbleTimer);window.dragonHitRegion.refresh()');await delay(120);
   await checkRegion(scale,'bubble-open',[...dragonPoints,...bubblePoints]);
   await widget.webContents.executeJavaScript('hideQuotaBubble();window.dragonHitRegion.refresh()');await delay(120);
   await checkRegion(scale,'bubble-closed',[...dragonPoints,...bubblePoints.map(p=>({...p,expected:false}))]);
  }
  settings.scale=1;settings.flip=true;applyWindow();await widget.webContents.executeJavaScript(`document.getElementById('dragon-wrap').classList.add('flipped');temporaryMood('pinch',10000);notice({title:'透点测试',body:'窗口气泡轮廓测试'});window.dragonHitRegion.refresh()`);await delay(180);
  const noticePoints=await widget.webContents.executeJavaScript(`(()=>{const r=document.getElementById('notice').getBoundingClientRect();return [{name:'visible-notice',x:r.x+15,y:r.y+r.height/2,expected:true}]})()`);
  const open=await nativeRegion(widget.getNativeWindowHandle().readBigUInt64LE().toString(),noticePoints);assert.equal(open.points[0].inside,true);report.native.push({scale:1,notice:true,...open});
  await widget.webContents.executeJavaScript(`document.getElementById('notice').hidden=true;window.dragonHitRegion.refresh()`);await delay(150);
  const closed=await nativeRegion(widget.getNativeWindowHandle().readBigUInt64LE().toString(),noticePoints.map(p=>({...p,expected:false})));assert.equal(closed.points[0].inside,false,'closing the notice must release its click region');report.native.push({scale:1,notice:false,...closed});
 }finally{
  Object.assign(settings,original);applyWindow();placeWidget(originalBounds.x,originalBounds.y);persist();await widget.webContents.executeJavaScript(`clearTimeout(moodTimer);moodTimer=null;hideQuotaBubble();document.getElementById('notice').hidden=true;render(state);window.dragonHitRegion.refresh()`);fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
 }
};
