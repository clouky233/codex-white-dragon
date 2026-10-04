// Opt-in local application integration test. Fixtures never enter quota storage or production history.
const assert=require('node:assert/strict'),fs=require('node:fs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
module.exports=async({widget,openSettings,getPrefs,state,settings,applyWindow,persist,reportFile})=>{
 const original=structuredClone(settings),results=[];
 const check=(name,condition)=>{assert.ok(condition,name);results.push({name,pass:true});};
 try{
  const initial=await widget.webContents.executeJavaScript('window.dragon.getState()');
  check('real quota service supplied a snapshot',!!initial.quota?.source&&Array.isArray(initial.quota.windows));
  check('node integration is absent from renderer',await widget.webContents.executeJavaScript('typeof require === "undefined" && typeof process === "undefined"'));
  check('atlas decodes at expected dimensions',await widget.webContents.executeJavaScript('new Promise(r=>{const i=new Image();i.onload=()=>r(i.naturalWidth===1536&&i.naturalHeight===1024);i.onerror=()=>r(false);i.src="../../assets/dragon-states.png"})'));
  check('startup shows only the dragon without the removed labels or quota card',await widget.webContents.executeJavaScript('document.getElementById("quota-bubble").hidden && !document.querySelector(".caption,.brand,#plan,#status,#warning") && !document.body.innerText.trim()'));
  const resting=await widget.webContents.executeJavaScript('(()=>{document.body.classList.add("reduced");const r=document.getElementById("dragon-wrap").getBoundingClientRect();return {x:r.x,y:r.y}})()');
  const point=await widget.webContents.executeJavaScript('(()=>{const r=document.getElementById("dragon").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  widget.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});widget.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});await delay(100);
  check('pinch interaction changes expression',await widget.webContents.executeJavaScript('document.getElementById("dragon").classList.contains("pinch")'));
  check('clicking the dragon opens the quota bubble without moving the character',await widget.webContents.executeJavaScript(`(()=>{const r=document.getElementById('dragon-wrap').getBoundingClientRect();return !document.getElementById('quota-bubble').hidden&&Math.abs(r.x-${resting.x})<1&&Math.abs(r.y-${resting.y})<1})()`));
  await delay(2600);await widget.webContents.executeJavaScript('showQuotaBubble()');await delay(2800);
  check('a repeated click resets the bubble lifetime',await widget.webContents.executeJavaScript('!document.getElementById("quota-bubble").hidden'));
  await delay(2350);check('quota bubble hides after five seconds',await widget.webContents.executeJavaScript('document.getElementById("quota-bubble").hidden'));
  await widget.webContents.executeJavaScript('showQuotaBubble();document.getElementById("quota-bubble").dispatchEvent(new PointerEvent("pointerenter"))');await delay(5150);
  check('hover keeps the bubble available for its controls',await widget.webContents.executeJavaScript('!document.getElementById("quota-bubble").hidden'));
  await widget.webContents.executeJavaScript('document.getElementById("quota-bubble").dispatchEvent(new PointerEvent("pointerleave"))');await delay(5150);
  check('leaving the bubble restarts automatic dismissal',await widget.webContents.executeJavaScript('document.getElementById("quota-bubble").hidden'));
  widget.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});widget.webContents.sendInputEvent({type:'mouseMove',x:point.x+18,y:point.y+10});widget.webContents.sendInputEvent({type:'mouseUp',x:point.x+18,y:point.y+10,button:'left',clickCount:1});await delay(100);
  check('drag release does not open the quota bubble',await widget.webContents.executeJavaScript('document.getElementById("quota-bubble").hidden'));
  openSettings();const prefs=getPrefs();if(prefs.webContents.isLoading())await new Promise(r=>prefs.webContents.once('did-finish-load',r));await delay(200);
  check('settings no longer contains the removed disclaimer panel',await prefs.webContents.executeJavaScript('!document.querySelector(".note") && !document.getElementById("diagnostic").textContent.includes("尚未与桌面账号核对")'));
  await prefs.webContents.executeJavaScript('window.dragon.saveSettings({scale:.8,flip:true,sound:false,accent:"#9073aa"})');await delay(100);
  check('settings update native zoom and are returned to renderer',widget.webContents.getZoomFactor()===.8&&(await prefs.webContents.executeJavaScript('window.dragon.getState()')).settings.flip===true);
  await prefs.webContents.executeJavaScript('document.getElementById("test-notice").click()');await delay(150);
  check('notification preview reaches the widget without a task',await widget.webContents.executeJavaScript('!document.getElementById("notice").hidden && document.getElementById("notice-title").textContent.includes("预览")'));
  // Layout-only fixture exercises several buckets, unknown fields and an offline message.
  const fixture=structuredClone(state());fixture.quota.windows=Array.from({length:5},(_,i)=>({...initial.quota.windows[0],id:'layout:'+i,label:'布局测试 '+i}));fixture.quota.status='offline';fixture.quota.error={message:'离线布局验证，保留上次真实快照'};
  await widget.webContents.executeJavaScript(`render(${JSON.stringify(fixture)});showQuotaBubble()`);
  check('many windows scroll inside the on-demand bubble',await widget.webContents.executeJavaScript('(()=>{const w=document.getElementById("windows"),c=document.getElementById("quota-bubble");return w.scrollHeight>w.clientHeight&&c.getBoundingClientRect().top>=0&&c.getBoundingClientRect().bottom<=innerHeight})()'));
  const [x,y]=widget.getPosition();await widget.webContents.executeJavaScript('window.dragon.move()');await delay(100);check('move without a held drag anchor cannot move or resize the window',widget.getPosition()[0]===x&&widget.getPosition()[1]===y);
 }finally{
  Object.assign(settings,original);applyWindow();persist();const real=state();await widget.webContents.executeJavaScript(`clearTimeout(moodTimer);moodTimer=null;clearTimeout(noticeTimer);document.getElementById('notice').hidden=true;hideQuotaBubble();render(${JSON.stringify(real)})`);fs.writeFileSync(reportFile,JSON.stringify(results,null,2));
 }
};
