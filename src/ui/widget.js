const $ = id => document.getElementById(id);
let state = {}, currentMood = 'idle', moodTimer, noticeTimer, bubbleTimer, bubbleHovered = false, dragging = false, dragStart;
const BUBBLE_DURATION_MS = 5000;
const statusNames = {connecting:'连接中',ready:'',unverified:'',stale:'数据陈旧',expired:'等待重置确认',offline:'离线',unavailable:'暂不可用',stopped:'已停止'};
const dateTime = value => Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}) : '时间未提供';
function countdown(timestamp) { if (!Number.isFinite(timestamp)) return '重置时间未提供'; const secs = Math.ceil((timestamp-Date.now())/1000); if (secs<=0) return '已到重置时间，等待刷新';const days=Math.floor(secs/86400), hours=Math.floor(secs%86400/3600),mins=Math.floor(secs%3600/60);return `${days?days+'天 ':''}${hours}小时 ${mins}分后重置`; }
function node(tag, cls, text){const e=document.createElement(tag);e.className=cls||'';if(text!==undefined)e.textContent=text;return e;}
function render(next) {
 state=next;const q=state.quota||{};const p=state.settings||{};
 document.body.classList.toggle('reduced',!!p.reducedMotion);document.documentElement.style.setProperty('--accent',p.accent||'#9b7cbd');$('dragon-wrap').classList.toggle('flipped',!!p.flip);
 const holder=$('windows');holder.replaceChildren();const windows=q.windows||[];
 for(const w of windows){const div=node('div','window'+(w.remainingPercent!==null&&w.remainingPercent<=15?' low':''));const top=node('div','window-top');top.append(node('span','window-label',w.label));const num=node('div','remaining');num.append(node('span','','剩余'),document.createTextNode(Number.isFinite(w.remainingPercent)?String(Math.round(w.remainingPercent*10)/10):'—'),node('small','','%'));top.append(num);const meter=node('div','meter'),fill=node('div','fill');fill.style.width=`${Number.isFinite(w.remainingPercent)?Math.max(0,Math.min(100,w.remainingPercent)):0}%`;meter.append(fill);const reset=node('div','reset');reset.append(node('span','countdown',countdown(w.resetsAt)),node('span','reset-time',dateTime(w.resetsAt)));div.append(top,meter,reset);holder.append(div);}
 if(!windows.length)holder.append(node('div','empty',q.status==='connecting'?'正在读取本机 Codex 账户…':'暂时无法读取额度\n打开设置查看连接状态'));
 const missing=[];if(!windows.some(w=>w.windowDurationMins===300))missing.push('五小时额度未提供');if(!windows.some(w=>w.windowDurationMins===10080))missing.push('每周额度未提供');$('missing').textContent=windows.length?missing.join(' · '):'无数据时不会估算额度';$('missing').hidden=windows.length>0&&!missing.length;
 const freshness=statusNames[q.status]||'';
 $('updated').textContent=(freshness?freshness+' · ':'')+(q.observedAt?'更新于 '+new Date(q.observedAt).toLocaleTimeString('zh-CN',{hour12:false}):'尚无有效快照');
 if(!moodTimer){const low=windows.some(w=>w.remainingPercent!==null&&w.remainingPercent<=p.lowThreshold);setMood(state.activeTurns>0?'thinking':low?'low':q.status==='offline'||q.status==='unavailable'?'error':'idle');}
}
function setMood(mood){currentMood=mood;$('dragon').className='dragon '+mood;$('dragon').style.translate=`0 ${({idle:1,thinking:1,complete:0,waiting:22,low:23,pinch:25,error:23}[mood]||0)/512*230}px`;$('dragon-wrap').classList.toggle('busy',mood==='thinking');}
function hideQuotaBubble(){clearTimeout(bubbleTimer);bubbleTimer=null;bubbleHovered=false;$('quota-bubble').hidden=true;$('dragon').setAttribute('aria-expanded','false');window.dragonHitRegion?.refresh();}
function scheduleBubbleClose(){clearTimeout(bubbleTimer);if(!$('quota-bubble').hidden&&!bubbleHovered)bubbleTimer=setTimeout(hideQuotaBubble,BUBBLE_DURATION_MS);}
function showQuotaBubble(){clearTimeout(noticeTimer);$('notice').hidden=true;$('quota-bubble').hidden=false;$('dragon').setAttribute('aria-expanded','true');scheduleBubbleClose();window.dragonHitRegion?.refresh();}
$('quota-bubble').addEventListener('pointerenter',()=>{bubbleHovered=true;clearTimeout(bubbleTimer);});
$('quota-bubble').addEventListener('pointerleave',()=>{bubbleHovered=false;scheduleBubbleClose();});
$('quota-bubble').addEventListener('pointerdown',scheduleBubbleClose);
$('dragon').addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();temporaryMood('pinch',1800);showQuotaBubble();}});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){hideQuotaBubble();$('notice').hidden=true;window.dragonHitRegion?.refresh();}});
function temporaryMood(mood,ms=4000){clearTimeout(moodTimer);setMood(mood);moodTimer=setTimeout(()=>{moodTimer=null;render(state);},ms);}
function chime(){if(!state.settings?.sound)return;try{const c=new AudioContext(),gain=c.createGain();gain.connect(c.destination);gain.gain.value=Math.max(0,Math.min(1,state.settings.volume??.25))*.12;[659.25,880].forEach((f,i)=>{const o=c.createOscillator();o.frequency.value=f;o.connect(gain);o.start(c.currentTime+i*.13);o.stop(c.currentTime+i*.13+.2);});setTimeout(()=>c.close(),900);}catch{}}
function notice(value){hideQuotaBubble();$('notice-title').textContent=value.title||'本轮完成';$('notice-body').textContent=value.body||'';$('notice').hidden=false;window.dragonHitRegion?.refresh();clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>{$('notice').hidden=true;window.dragonHitRegion?.refresh();},(state.settings?.noticeSeconds||12)*1000);temporaryMood(value.kind==='error'?'error':'complete',6000);chime();}
$('refresh').onclick=async()=>{const b=$('refresh');b.disabled=true;await window.dragon.refresh();b.disabled=false;};
$('settings').onclick=()=>window.dragon.settings();$('hide').onclick=()=>{hideQuotaBubble();window.dragon.action('hide');};$('dismiss').onclick=()=>{$('notice').hidden=true;window.dragonHitRegion?.refresh();};
function finishDrag(pinch=false){if(!dragStart)return;if(pinch&&!dragging&&dragStart.isDragon){temporaryMood('pinch',1800);showQuotaBubble();}dragStart=null;$('dragon-wrap').classList.remove('dragging','held');window.dragon.endMove();}
for(const handle of [$('dragon')]){
 handle.addEventListener('pointerdown',e=>{if(e.button!==0)return;dragging=false;dragStart={x:e.screenX,y:e.screenY,isDragon:handle===$('dragon')};$('dragon-wrap').classList.add('held');e.currentTarget.setPointerCapture(e.pointerId);window.dragon.beginMove();});
 handle.addEventListener('pointermove',e=>{if(!dragStart)return;if(!(e.buttons&1)){finishDrag(false);return;}if(Math.abs(e.screenX-dragStart.x)+Math.abs(e.screenY-dragStart.y)>4)dragging=true;if(dragging){hideQuotaBubble();$('dragon-wrap').classList.add('dragging');window.dragon.move();}});
 handle.addEventListener('pointerup',()=>finishDrag(true));handle.addEventListener('pointercancel',()=>finishDrag(false));handle.addEventListener('lostpointercapture',()=>finishDrag(false));
}
window.addEventListener('blur',()=>finishDrag(false));
$('dragon').addEventListener('contextmenu',e=>{e.preventDefault();window.dragon.action('menu');});
window.dragon.onState(render);window.dragon.onNotice(notice);window.dragon.getState().then(render);
setInterval(()=>{document.querySelectorAll('.countdown').forEach((e,i)=>e.textContent=countdown(state.quota?.windows?.[i]?.resetsAt));},1000);
