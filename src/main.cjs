const {app,BrowserWindow,ipcMain,Menu,Tray,nativeImage,screen,Notification} = require('electron');
const path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const {pathToFileURL}=require('node:url');
app.setName('Codex White Dragon');
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.setPath('userData',path.join(app.getPath('appData'),'CodexWhiteDragon'));
 const arg=(name)=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
const capture=arg('capture'),captureSettings=arg('capture-settings');
const testing=!!(capture||captureSettings);
if(!testing&&!app.requestSingleInstanceLock()){app.quit();}
else {
 let widget,prefs,tray,quota,monitor,activeTurns=0,quitting=false,saveTimer,lowKey='',dragAnchor=null,lastHitRegion=[],inputReady=false;
 const dataDir=app.getPath('userData'),settingsFile=path.join(dataDir,'settings.json'),historyFile=path.join(dataDir,'history.json');
 const defaults={scale:1,alwaysOnTop:true,flip:false,sound:true,volume:.25,lowThreshold:15,noticeSeconds:12,reducedMotion:false,nativeNotifications:false,accent:'#9b7cbd'};
 const read=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}};
 let settings={...defaults,...read(settingsFile,{})};
 if(process.env.CODEX_DRAGON_EXPECTED_ACCOUNT_ID)settings.expectedAccountId=process.env.CODEX_DRAGON_EXPECTED_ACCOUNT_ID;
 let history=read(historyFile,[]);if(!Array.isArray(history))history=[];history=history.slice(-300);
 let points=[];
 function findCodex(){
  for(const candidate of [process.env.CODEX_DRAGON_CODEX_PATH,settings.codexPath])if(candidate&&fs.existsSync(candidate))return candidate;
  const bin=path.join(process.env.LOCALAPPDATA||app.getPath('appData'),'OpenAI','Codex','bin');
  try{const candidates=fs.readdirSync(bin,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>path.join(bin,d.name,'codex.exe')).filter(p=>fs.existsSync(p)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);if(candidates.length){settings.codexPath=candidates[0];return candidates[0];}}catch{}
  return 'codex.exe';
 }
 const persist=()=>{fs.mkdirSync(dataDir,{recursive:true});fs.writeFileSync(settingsFile,JSON.stringify(settings,null,2));fs.writeFileSync(historyFile,JSON.stringify(history.slice(-300),null,2));};
 const safeSettings=()=>{const {expectedAccountId,codexPath,...rest}=settings;return rest;};
 const state=()=>({quota:quota?.snapshot||{status:'connecting',windows:[]},settings:safeSettings(),activeTurns,history:history.slice(-100),points:points.slice(-180),monitor:monitor?.snapshot||{status:settings.expectedAccountId?'connecting':'unbound'},version:app.getVersion(),geometry:widget&&!widget.isDestroyed()?{bounds:widget.getBounds(),target:widgetSize(),scaleFactor:screen.getDisplayMatching(widget.getBounds()).scaleFactor}:null});
 const broadcast=()=>{for(const w of [widget,prefs])if(w&&!w.isDestroyed())w.webContents.send('state',state());};
 const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
 const widgetSize=()=>{const scale=clamp(Number(settings.scale)||1,.65,1.4);return {width:Math.round(370*scale),height:Math.round(570*scale)};};
 function rememberPosition(){if(!widget||widget.isDestroyed())return;const [x,y]=widget.getPosition();settings.position={x,y};clearTimeout(saveTimer);saveTimer=setTimeout(persist,300);}
 function placeWidget(x,y,snap=false){
  if(!widget||widget.isDestroyed())return;const size=widgetSize(),a=screen.getDisplayMatching({x:Math.round(x),y:Math.round(y),...size}).workArea;
  x=clamp(x,a.x,Math.max(a.x,a.x+a.width-size.width));y=clamp(y,a.y,Math.max(a.y,a.y+a.height-size.height));
  if(snap){if(x-a.x<28)x=a.x;if(a.x+a.width-x-size.width<28)x=a.x+a.width-size.width;}
  // Never feed getBounds width/height back into setPosition: Windows fractional DPI
  // adds rounding pixels on each move. Explicit design dimensions prevent accumulation.
  const target={x:Math.round(x),y:Math.round(y),...size},current=widget.getBounds();
  if(current.x!==target.x||current.y!==target.y||Math.abs(current.width-target.width)>3||Math.abs(current.height-target.height)>3)widget.setBounds(target,false);
  rememberPosition();
 }
 function constrain(snap=false){if(widget&&!widget.isDestroyed()){const [x,y]=widget.getPosition();placeWidget(x,y,snap);}}
 function applyWindow(){if(!widget)return;const scale=clamp(Number(settings.scale)||1,.65,1.4);widget.webContents.setZoomFactor(scale);widget.setAlwaysOnTop(!!settings.alwaysOnTop,'floating');constrain();}
 function windowOptions(extra={}){return {webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,backgroundThrottling:false},...extra};}
 function protect(w){w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.webContents.on('will-navigate',e=>e.preventDefault());w.webContents.on('will-attach-webview',e=>e.preventDefault());}
 function openSettings(){if(prefs&&!prefs.isDestroyed()){prefs.show();prefs.focus();return;}prefs=new BrowserWindow(windowOptions({width:870,height:790,minWidth:760,minHeight:600,title:'Codex 白龙 · 设置与记录',backgroundColor:'#f6f2f9',autoHideMenuBar:true,show:!testing}));protect(prefs);prefs.loadFile(path.join(__dirname,'ui','settings.html'));prefs.on('closed',()=>{prefs=null;});}
 function contextMenu(){Menu.buildFromTemplate([{label:'显示白龙',click:()=>{widget.show();constrain();}},{label:'刷新真实额度',click:()=>quota.refresh()},{label:'设置与记录',click:openSettings},{label:'始终置顶',type:'checkbox',checked:settings.alwaysOnTop,click:i=>{settings.alwaysOnTop=i.checked;applyWindow();persist();broadcast();}},{type:'separator'},{label:'退出白龙',click:()=>{quitting=true;app.quit();}}]).popup();}
 function showNotice(value,save=true){if(save){history.push(value);history=history.slice(-300);persist();}if(widget&&!widget.isDestroyed())widget.webContents.send('notice',value);if(settings.nativeNotifications&&Notification.isSupported())new Notification({title:value.title,body:value.body,silent:true}).show();broadcast();}
 function validSender(event){return [widget,prefs].some(w=>w&&!w.isDestroyed()&&event.sender.id===w.webContents.id);}
 ipcMain.handle('state',event=>validSender(event)?state():null);
 ipcMain.handle('refresh',async event=>{if(validSender(event)){await quota.refresh();broadcast();return state();}return null;});
 ipcMain.on('settings',event=>{if(validSender(event))openSettings();});
 ipcMain.handle('save-settings',(event,value)=>{if(!validSender(event)||!value||typeof value!=='object')return null;
  for(const key of ['alwaysOnTop','flip','sound','reducedMotion','nativeNotifications'])if(typeof value[key]==='boolean')settings[key]=value[key];
  for(const [key,min,max] of [['scale',.65,1.4],['volume',0,1],['lowThreshold',1,50],['noticeSeconds',3,60]])if(typeof value[key]==='number'&&Number.isFinite(value[key]))settings[key]=clamp(value[key],min,max);
  if(typeof value.accent==='string'&&/^#[0-9a-f]{6}$/i.test(value.accent))settings.accent=value.accent;
  persist();applyWindow();broadcast();return safeSettings();});
 ipcMain.on('begin-move',event=>{if(validSender(event)&&event.sender===widget.webContents){const [x,y]=widget.getPosition();dragAnchor={cursor:screen.getCursorScreenPoint(),x,y};}});
 ipcMain.on('move',event=>{if(!validSender(event)||event.sender!==widget.webContents||!dragAnchor)return;const cursor=screen.getCursorScreenPoint();placeWidget(dragAnchor.x+cursor.x-dragAnchor.cursor.x,dragAnchor.y+cursor.y-dragAnchor.cursor.y);});
 ipcMain.on('end-move',event=>{if(validSender(event)&&event.sender===widget.webContents){dragAnchor=null;constrain(true);}});
 ipcMain.on('hit-region',(event,value)=>{
  if(!widget||event.sender!==widget.webContents||!Array.isArray(value?.rects)||value.rects.length===0||value.rects.length>5000)return;
  const zoom=widget.webContents.getZoomFactor(),size=widget.getContentBounds();const rects=[];
  for(const r of value.rects){if(!r||![r.x,r.y,r.width,r.height].every(Number.isFinite)||r.width<=0||r.height<=0)return;
   const x=clamp(Math.floor(r.x*zoom),0,size.width),y=clamp(Math.floor(r.y*zoom),0,size.height),right=clamp(Math.ceil((r.x+r.width)*zoom),0,size.width),bottom=clamp(Math.ceil((r.y+r.height)*zoom),0,size.height);
   if(right>x&&bottom>y)rects.push({x,y,width:right-x,height:bottom-y});}
  if(rects.length){widget.setShape(rects);lastHitRegion=rects;if(!inputReady){widget.setIgnoreMouseEvents(false);inputReady=true;}}
 });
 ipcMain.on('action',(event,action)=>{if(!validSender(event))return;if(action==='hide')widget.hide();if(action==='menu')contextMenu();if(action==='show')widget.show();if(action==='quit'){quitting=true;app.quit();}if(action==='test-notice')showNotice({id:'preview-'+Date.now(),kind:'complete',title:'提示音与气泡预览',body:'这是交互预览，没有执行任务或消耗推理额度。',completedAt:Date.now()},false);if(action==='clear-history'){history=[];persist();broadcast();}});
 app.on('second-instance',()=>{if(widget){widget.show();widget.focus();}});
 app.on('before-quit',()=>{quitting=true;clearTimeout(saveTimer);monitor?.stop();quota?.stop();persist();});
 app.on('window-all-closed',()=>{if(!tray)app.quit();});
 app.whenReady().then(async()=>{
  const [{QuotaService},{SessionMonitor}]=await Promise.all([import(pathToFileURL(path.join(__dirname,'quota.mjs'))),import(pathToFileURL(path.join(__dirname,'sessions.mjs')))]);
  const a=screen.getPrimaryDisplay().workArea;const position=settings.position||{x:a.x+a.width-390,y:a.y+a.height-590};
  widget=new BrowserWindow(windowOptions({width:370,height:570,x:Math.round(position.x),y:Math.round(position.y),transparent:true,frame:false,thickFrame:false,resizable:false,maximizable:false,hasShadow:false,backgroundColor:'#00000000',skipTaskbar:true,alwaysOnTop:!!settings.alwaysOnTop,show:false,title:'Codex 白龙额度挂件'}));protect(widget);
  // Stay click-through until the visible dragon's alpha region is available.
  widget.setShape([{x:0,y:0,width:1,height:1}]);widget.setIgnoreMouseEvents(true);
  widget.on('close',event=>{if(!quitting&&!testing){event.preventDefault();widget.hide();}});widget.on('moved',rememberPosition);
  widget.on('blur',()=>{if(dragAnchor){dragAnchor=null;constrain(true);}});
  await widget.loadFile(path.join(__dirname,'ui','index.html'));applyWindow();if(!testing)widget.show();
  const image=nativeImage.createFromPath(path.join(__dirname,'..','assets','dragon-states.png'));if(!image.isEmpty()){const size=image.getSize();tray=new Tray(image.crop({x:0,y:0,width:Math.floor(size.width/3),height:Math.floor(size.height/2)}).resize({width:32,height:32}));tray.setToolTip('Codex 白龙 · 订阅额度');tray.on('click',()=>widget.isVisible()?widget.hide():widget.show());tray.on('right-click',contextMenu);}
  quota=new QuotaService({expectedAccountId:settings.expectedAccountId,codexPath:findCodex(),pollIntervalMs:60000});
  quota.on('snapshot',q=>{if(monitor){if(q.identityVerified)void monitor.start();else monitor.stop();}if(q.status==='ready'&&q.observedAt){const p={at:q.observedAt,windows:q.windows};if(points.at(-1)?.at!==p.at)points.push(p);points=points.slice(-180);const low=q.windows.find(w=>Number.isFinite(w.remainingPercent)&&w.remainingPercent<=settings.lowThreshold);const key=low?`${low.id}:${low.resetsAt}`:'';if(key&&key!==lowKey){showNotice({id:'low-'+Date.now(),kind:'warning',title:'额度提醒',body:`${low.label}剩余 ${low.remainingPercent}%。可以放慢一点。`,completedAt:Date.now()},false);}lowKey=key;}broadcast();});
  monitor=new SessionMonitor({codexHome:process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),expectedAccountId:settings.expectedAccountId,getQuota:()=>quota.snapshot,refreshQuota:()=>quota.refresh()});
  monitor.on('active',count=>{activeTurns=Number(count)||0;broadcast();});monitor.on('notice',value=>showNotice(value));
  await quota.start();broadcast();persist();
  if(captureSettings)openSettings();
  if(capture&&process.argv.includes('--capture-bubble')){widget.showInactive();setTimeout(()=>widget.webContents.executeJavaScript('showQuotaBubble()'),3000);}
  if(testing)setTimeout(async()=>{try{if(process.argv.includes('--self-test')){const run=require('./self-test.cjs');await run({widget,openSettings,getPrefs:()=>prefs,state,settings,applyWindow,persist,reportFile:(captureSettings||capture)+'.tests.json'});}if(process.argv.includes('--geometry-test')){const run=require('./geometry-test.cjs');await run({widget,settings,applyWindow,placeWidget,getHitRegion:()=>lastHitRegion,persist,reportFile:(captureSettings||capture)+'.geometry.json'});}const target=captureSettings?prefs:widget;const check=await target.webContents.executeJavaScript(`({title:document.title,bodyText:document.body.innerText,scrollWidth:document.documentElement.scrollWidth,innerWidth:innerWidth,scrollHeight:document.documentElement.scrollHeight,innerHeight:innerHeight,bridge:!!window.dragon,images:[...document.images].map(i=>({complete:i.complete,width:i.naturalWidth}))})`);const screenshot=await target.webContents.capturePage();const file=captureSettings||capture;fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,screenshot.toPNG());fs.writeFileSync(file+'.json',JSON.stringify(check,null,2));}catch(err){fs.writeFileSync((captureSettings||capture)+'.error.txt',String(err.stack));process.exitCode=1;}finally{quitting=true;app.quit();}},4000);
 }).catch(err=>{process.stderr.write('白龙启动失败：'+err.message+'\n');app.exit(1);});
}
