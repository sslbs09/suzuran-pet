"use strict";

// Real Electron visual acceptance. Test setup only selects the initial edge
// and episode; the production V2 controller performs the reversal.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const assert = require("node:assert/strict");
const { _electron } = require("playwright");
const ROOT = path.resolve(__dirname, "..");
const OUTPUT_PARENT = process.env.EDGE_OUTPUT_PARENT || os.tmpdir();
fs.mkdirSync(OUTPUT_PARENT, { recursive: true });
const OUT = fs.mkdtempSync(path.join(OUTPUT_PARENT, "bug03-visual-"));
const USER = path.join(OUT, "user"), SKIN = "build_char_298_susuro_winter_4";
const COUNT = Number(process.env.EDGE_TURNS || 5);
const ADMISSION_PROBE=process.env.EDGE_ADMISSION_PROBE==='1';
const SEED_DISTANCE=Number(process.env.EDGE_SEED_DISTANCE||45);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const overviewPanels=[];
const METRICS={
  bodyCore:'F_Chest current applied worldX transformed by spine.x + scale.x*worldX; DOM canvas ratio yields local CSS/DIP x.',
  upperBody:'Alpha-weighted centroid of current actual RT pixels with alpha>32 above the current F_Chest y (head, hair, hat and upper body); mirrored facial asymmetry can change this value.',
  wholeSprite:'Alpha-weighted centroid of all current actual RT pixels with alpha>32, including equipment; equipment side changes are not body translation.',
  alphaExtent:'Min/max current RT x with alpha>32; padded current pose proves whether an edge touch extends outside the actual canvas.',
  screenPosition:'Local CSS/DIP x plus last native setPosition/setSize/setBounds postmutation snapshot at or before frame.ts; nearest polling age is supplementary.',
  compositor:'Actual capturePage PNG; capture start timestamp and offset are recorded, without claiming an exact same-frame match.'
};

function prepare() {
  const assets = path.join(USER, "assets/spine/user/winter");
  fs.mkdirSync(assets, { recursive: true });
  const source = process.env.EDGE_SKIN_DIR || "C:\\Users\\xsbil\\AppData\\Roaming\\苏苏洛桌宠 2.5 正式版\\assets\\spine\\user\\winter";
  for (const ext of [".atlas", ".png", ".skel"]) fs.copyFileSync(path.join(source, SKIN + ext), path.join(assets, SKIN + ext));
  fs.writeFileSync(path.join(USER, "config.json"), JSON.stringify({
    agreed: true, firstRun: false, renderMode: "spine", spineSkinId: "winter/" + SKIN,
    walking: false, walkSpeedMul: 1, startHidden: false, greetingOnStart: false,
    proactiveChat: false, personify: false, zcodeEnabled: false,
    window: { width: 260, height: 200, scale: 1 },
    tts: { enabled: false }, ttsCloud: { enabled: false }, ttsCosy: { enabled: false },
    ttsGenie: { enabled: false }, ttsGsv: { enabled: false }, agentApi: { enabled: false },
    whitemoonRuntime: { enabled: false }
  }));
  fs.writeFileSync(path.join(USER, ".storage-migration-v1.json"), "{}");
  const hook = `
global.__edgeAcceptance = {
 rows: [], timer: null, mutations: [],
 sample() {
  const b=win.getBounds(),d=screen.getDisplayMatching(b),st=v2Locomotion.stats();
  return {ts:Date.now(),bounds:b,display:d.id,workArea:d.workArea,dir:walk.dir,face:walk.face,
    seated:walk.seated,resting:walk.resting,inset:charStripInset(b),compact:walk.uiEdgeCompact,
    v2:st,phase:global.__edgeController.phase(),episodeId:global.__edgeController.episodeId(),
    commitCounters:v2Commit.stats,committed:global.__edgeLastCommit,owner:st.authority};
 },
 seed(side) {
  if(!v2CanEnterSlice().ok) throw new Error('seed rejected: '+JSON.stringify(v2CanEnterSlice()));
  clearTimeout(walk.phaseTimer);walk.phaseTimer=null;
  const b=win.getBounds(),wa=walkGeo.workAreaOf(screen,b);
  const r=walkGeo.clampWalkX(b.x,wa,b.width,false,charStripInset(b));
  // Initial teleport is outside the measured -500ms..+1500ms window.
  win.setPosition(Math.round(side==='left'?r.minX+${SEED_DISTANCE}:r.maxX-${SEED_DISTANCE}),b.y);
  if(!win.__edgePositionWrapped){
    for(const method of ['setPosition','setSize','setBounds']){
      const original=win[method].bind(win);
      win[method]=(...args)=>{const res=original(...args);this.mutations.push(this.sample());return res;};
    }
    win.__edgePositionWrapped=true;
  }
  // Seed initial policy direction AND presentation face before the first Move
  // admission. Otherwise its first tick can mirror before its 150ms fit.
  walk.dir=side==='left'?-1:1;walk.face=walk.dir;updateChatPanelSideFromBounds(win.getBounds(),wa);
  this.rows=[];this.mutations=[this.sample()];if(this.timer)clearInterval(this.timer);
  this.timer=setInterval(()=>this.rows.push(this.sample()),16);
  const res=v2Locomotion.beginEpisode({dir:walk.dir,moveMs:60000});
  if(!res.ok)throw new Error(JSON.stringify(res));return res;
 }
};`;
  const entry=path.join(OUT,"entry.cjs");
  fs.writeFileSync(entry,`const fs=require('node:fs'),Module=require('node:module'),path=require('node:path');\nconst root=${JSON.stringify(ROOT)};require('electron').app.setAppPath(root);\nconst runtime=require(path.join(root,'src/runtime-v2'));\nconst originalController=runtime.createLocomotionController;runtime.createLocomotionController=(options)=>{const c=originalController(options);global.__edgeController=c;return c;};\nconst originalCommit=runtime.createWindowCommit;runtime.createWindowCommit=(options)=>{const notify=options.notifyWrite;return originalCommit({...options,notifyWrite:(result)=>{global.__edgeLastCommit={...result,ts:Date.now()};if(notify)notify(result);}});};\nconst name=path.join(root,'main.js'),m=new Module(name,module);m.filename=name;m.paths=Module._nodeModulePaths(root);require.cache[name]=m;m._compile(fs.readFileSync(name,'utf8')+${JSON.stringify(hook)},name);`);
  return entry;
}

async function installFrames(page) {
  await page.evaluate(() => {
    window.__edgeFrames=[];window.__edgeRecording=true;
    let reversalAt=null,paddedDelayed=false;
    const record=()=>{
      if(!window.__edgeRecording)return;
      let rt;
      try {
        const W=spineApp.screen.width,H=spineApp.screen.height;
        rt=PIXI.RenderTexture.create({width:Math.ceil(W),height:Math.ceil(H)});
        // Current actual stage; no fit projection or alteration of x/y/scale.
        spineApp.renderer.render(spineApp.stage,{renderTexture:rt,clear:true});
        const px=spineApp.renderer.extract.pixels(rt),w=rt.width,h=rt.height;
        const chest=spineObj.skeleton.findBone('F_Chest');
        const coreX=chest?spineObj.x+spineObj.scale.x*chest.worldX:null;
        const coreY=chest?spineObj.y+spineObj.scale.y*chest.worldY:null;
        let sum=0,mass=0,min=w,max=-1,headSum=0,headMass=0;
        for(let y=0;y<h;y++)for(let x=0;x<w;x++){
          const a=px[(y*w+x)*4+3];
          if(a>32){sum+=x*a;mass+=a;min=Math.min(min,x);max=Math.max(max,x);
            if(coreY!==null&&y<coreY){headSum+=x*a;headMass+=a;}}
        }
        const pet=petEl.getBoundingClientRect(),canvas=spineApp.view.getBoundingClientRect();
        const b=spineObj.getBounds(),c=spineObj.state.getCurrent(0),ratio=canvas.width/W;
        const ts=Date.now(),previous=window.__edgeFrames.at(-1);
        const reversal=window.__edgeFrames.length>20&&previous&&Math.sign(previous.scaleX)!==Math.sign(spineObj.scale.x);
        if(reversal)reversalAt=ts;
        const delayed=reversalAt!==null&&!paddedDelayed&&ts>=reversalAt+150;
        let padded=null;
        if(reversal||delayed||min===0||max===w-1){
          let paddedRT;
          try{
            paddedRT=PIXI.RenderTexture.create({width:W*3,height:H*3});
            spineApp.renderer.render(spineObj,{renderTexture:paddedRT,clear:true,transform:new PIXI.Matrix(1,0,0,1,W,H)});
            const full=spineApp.renderer.extract.pixels(paddedRT);let left=paddedRT.width,right=-1;
            for(let yy=0;yy<paddedRT.height;yy++)for(let xx=0;xx<paddedRT.width;xx++)if(full[(yy*paddedRT.width+xx)*4+3]>32){left=Math.min(left,xx);right=Math.max(right,xx);}
            padded={kind:reversal?'flip':delayed?'+150ms':'edge-touch',left:left-W,right:right-W,
              outsideCanvas:left<W||right>=W*2,
              png:spineApp.renderer.extract.canvas(paddedRT).toDataURL('image/png')};
          }finally{if(paddedRT)paddedRT.destroy(true);}
          if(delayed)paddedDelayed=true;
        }
        window.__edgeFrames.push({ts,frame:window.__edgeFrames.length,
          screenX:window.screenX,outerWidth:window.outerWidth,innerWidth:window.innerWidth,dpr:window.devicePixelRatio,
          pet:{x:pet.x,y:pet.y,width:pet.width,height:pet.height},
          canvas:{x:canvas.x,y:canvas.y,width:canvas.width,height:canvas.height},
          spineX:spineObj.x,scaleX:spineObj.scale.x,face:walkState.face,
          anim:c?.animation?.name,trackTime:c?.trackTime,keepScale:spineFitKeepScale,
          bbox:{x:b.x,width:b.width},compact:document.body.classList.contains('ui-edge-compact'),
          bubbleVisible:!document.getElementById('bubble').classList.contains('hidden'),
          pixelCenter:mass?sum/mass:null,silhouetteCenter:max>=0?(min+max)/2:null,
          alphaLeft:mass?min:null,alphaRight:mass?max:null,canvasW:w,padded,
          localCenter:mass?canvas.x+sum/mass*ratio:null,
          core:{name:chest?.data.name,worldX:chest?.worldX,worldY:chest?.worldY,localX:coreX===null?null:canvas.x+coreX*ratio,
            transformErrorX:chest?spineObj.toGlobal(new PIXI.Point(chest.worldX,chest.worldY)).x-coreX:null},
          headCenter:headMass?canvas.x+headSum/headMass*ratio:null,
          png:spineApp.renderer.extract.canvas(rt).toDataURL('image/png')});
      }catch(error){window.__edgeFrameError=String(error.stack||error);}
      finally{if(rt)rt.destroy(true);}
      requestAnimationFrame(record);
    };requestAnimationFrame(record);
  });
}

function saveTrial(side,index,frames,mains,screenshots,mutations) {
  const flips=frames.filter((f,i)=>i&&Math.sign(f.scaleX)!==Math.sign(frames[i-1].scaleX));
  const flip=flips.find((f)=>f.anim==='Move'&&(ADMISSION_PROBE||frames.filter((x)=>x.ts<f.ts&&x.anim==='Move').length>=20));
  assert.ok(flip,side+' natural Move reversal missing');
  const firstMove=frames.find(f=>f.anim==='Move');
  const rows=frames.filter((f)=>f.ts>=(ADMISSION_PROBE?firstMove.ts:flip.ts-500)&&f.ts<=flip.ts+1500);
  const dir=path.join(OUT,side+'-'+index);fs.mkdirSync(dir);
  const selected=[rows.filter(f=>f.ts<flip.ts).at(-1),flip,
    rows.reduce((a,b)=>Math.abs(a.ts-flip.ts-150)<Math.abs(b.ts-flip.ts-150)?a:b)];
  for(const f of selected){
    // Keep compositor panels on the intended side of the flip. The nearest
    // capture can precede the nominal 0ms panel by one capture interval.
    const candidates=screenshots.filter(s=>f.ts<flip.ts?s.ts<=f.ts:s.ts>=f.ts);
    const shot=candidates.reduce((a,b)=>Math.abs(a.ts-f.ts)<Math.abs(b.ts-f.ts)?a:b);
    overviewPanels.push({side,index,deltaMs:f.ts-flip.ts,png:f.png,
      compositorPng:'data:image/png;base64,'+fs.readFileSync(path.join(OUT,shot.file)).toString('base64'),
      compositorFile:shot.file,compositorDeltaMs:shot.ts-f.ts,alphaLeft:f.alphaLeft,alphaRight:f.alphaRight});
  }
  for(const f of rows){
    const m=mains.reduce((best,r)=>Math.abs(r.ts-f.ts)<Math.abs(best.ts-f.ts)?r:best,mains[0]);
    const native=mutations.filter(r=>r.ts<=f.ts).at(-1);
    assert.ok(native,'native position valid before sampled frame');
    f.main=m;f.native=native;f.screenCenter=native.bounds.x+f.localCenter;f.alignmentMs=Math.abs(m.ts-f.ts);
    f.screenCoreX=native.bounds.x+f.core.localX;f.screenHeadX=native.bounds.x+f.headCenter;
    fs.writeFileSync(path.join(dir,String(f.frame).padStart(4,'0')+'.png'),Buffer.from(f.png.split(',')[1],'base64'));
    if(f.padded){
      fs.writeFileSync(path.join(dir,String(f.frame).padStart(4,'0')+'-padded.png'),Buffer.from(f.padded.png.split(',')[1],'base64'));
      delete f.padded.png;
    }
    delete f.png;
  }
  const jumps=rows.slice(1).map((f,i)=>({ts:f.ts,frame:f.frame,dt:f.ts-rows[i].ts,
    local:f.localCenter-rows[i].localCenter,window:f.native.bounds.x-rows[i].native.bounds.x,
    screen:f.screenCenter-rows[i].screenCenter,spine:f.spineX-rows[i].spineX,
    core:f.core.localX-rows[i].core.localX,head:f.headCenter-rows[i].headCenter,
    screenCore:f.screenCoreX-rows[i].screenCoreX,screenHead:f.screenHeadX-rows[i].screenHeadX}));
  const max=(key)=>Math.max(...jumps.map((r)=>Math.abs(r[key])));
  const summary={side,index,flipTs:flip.ts,frames:rows.length,maxWindowStep:max('window'),
    admissionProbe:ADMISSION_PROBE,seedDistance:SEED_DISTANCE,firstMoveTs:firstMove.ts,flipAfterFirstMoveMs:flip.ts-firstMove.ts,
    edgeTouchFrames:rows.filter(f=>f.alphaLeft===0||f.alphaRight===f.canvasW-1).length,
    bubbleVisibleFrames:rows.filter(f=>f.bubbleVisible).length,
    clippedFrames:rows.filter(f=>f.padded?.outsideCanvas).length,
    minLeftMargin:Math.min(...rows.map(f=>f.alphaLeft)),minRightMargin:Math.min(...rows.map(f=>f.canvasW-1-f.alphaRight)),
    maxLocalStep:max('local'),maxScreenStep:max('screen'),
    maxCoreStep:max('core'),maxHeadStep:max('head'),maxScreenCoreStep:max('screenCore'),maxScreenHeadStep:max('screenHead'),
    worst:jumps.reduce((a,b)=>Math.abs(a.screen)>Math.abs(b.screen)?a:b),
    maxAlignmentMs:Math.max(...rows.map((f)=>f.alignmentMs)),evidence:dir,
    // Numeric admission is supplementary; a reviewer must inspect body/core
    // continuity in the saved actual-pose and compositor frames.
    pass:max('window')<=5&&max('core')<=5&&max('head')<=8&&max('screenHead')<=8&&
      !rows.some(f=>f.padded?.outsideCanvas)};
  fs.writeFileSync(path.join(dir,'trace.json'),JSON.stringify({metrics:METRICS,summary,rows,jumps,mains,mutations,screenshots},null,2));
  return summary;
}

async function saveOverview(page){
  for(const [file,native,representative] of [
    ['final-walking-core-turn-overview.png',false,false],
    ['final-walking-core-compositor-overview.png',true,false],
    ['final-walking-core-flash-strip.png',false,true]]){
    const panels=representative?overviewPanels.filter(p=>p.index===1):overviewPanels;
    const png=await page.evaluate(async({panels,native,representative})=>{
      const columns=representative?3:6,cellW=native?280:260,cellH=native?245:445;
      const canvas=document.createElement('canvas');canvas.width=columns*cellW;canvas.height=Math.ceil(panels.length/columns)*cellH;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#dddde3';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.font='12px sans-serif';
      for(let i=0;i<panels.length;i++){
        const p=panels[i],img=new Image();img.src=native?p.compositorPng:p.png;await img.decode();
        const x=(i%columns)*cellW+10,y=Math.floor(i/columns)*cellH+30,w=native?260:240,h=native?200:400;
        ctx.fillStyle='#f8f8fa';ctx.fillRect(x,y,w,h);ctx.imageSmoothingEnabled=false;ctx.drawImage(img,x,y,w,h);
        ctx.strokeStyle='#8e8e9a';ctx.strokeRect(x,y,w,h);ctx.fillStyle='#151515';
        ctx.fillText(p.side+' '+p.index+' '+(p.deltaMs>=0?'+':'')+p.deltaMs+'ms',x,y-12);
        ctx.fillText(native?'capture offset '+p.compositorDeltaMs+'ms':'alpha ['+p.alphaLeft+','+p.alphaRight+'] / 120',x,y+h+14);
      }
      return canvas.toDataURL('image/png');
    },{panels,native,representative});
    fs.writeFileSync(path.join(OUT,file),Buffer.from(png.split(',')[1],'base64'));
  }
  fs.writeFileSync(path.join(OUT,'overview-frames.json'),JSON.stringify(overviewPanels.map(({png,compositorPng,...p})=>p),null,2));
}

async function main(){
  const entry=prepare();console.log('EVIDENCE='+OUT);
  const env={...process.env,SUZURAN_TEST_USERDIR:USER,SUSSURRO_EDGE_DIAG:'0'};delete env.ELECTRON_RUN_AS_NODE;
  const app=await _electron.launch({executablePath:path.join(ROOT,'node_modules/electron/dist/electron.exe'),
    args:['--user-data-dir='+path.join(OUT,'chromium'),entry],cwd:ROOT,env,timeout:60000});
  const summaries=[];
  try{
    const page=await app.firstWindow();
    await page.waitForFunction(()=>typeof spineObj!=='undefined'&&spineObj&&!spineBootstrapPending,{timeout:60000});
    await sleep(4500);
    await page.evaluate(()=>{
      window.__edgeFits=[];
      const originalFit=fitSpinePose;
      fitSpinePose=function(...args){
        const before=spineObj.x;
        const result=originalFit(...args),bone=spineObj.skeleton.findBone('F_Chest');
        window.__edgeFits.push({ts:Date.now(),before,after:spineObj.x,core:spineObj.x+spineObj.scale.x*bone.worldX,
          currentGeneration:spineFitGeneration,argsGeneration:args[0],mirror:!!args[3]?.mirrorEntry,
          mirrorMatch:!!args[3]?.mirrorEntry&&spineObj.state.getCurrent(0)===args[3].mirrorEntry,
          anim:spineObj.state.getCurrent(0)?.animation?.name,walkingCore:!!spineWalkingCoreBone(),walk:{...walkState}});
        return result;
      };
    });
    for(let i=1;i<=COUNT;i++)for(const side of ADMISSION_PROBE?['left']:['left','right']){
      await page.evaluate(()=>window.petAPI.setWalking(false));await sleep(250);
      // Use the real UI close handler before the measured episode; an isolated
      // no-key startup hint must not obscure the compositor body evidence.
      await page.evaluate(()=>document.getElementById('btn-close').click());
      await page.evaluate(()=>window.petAPI.setWalking(true));
      await app.evaluate((_,side)=>global.__edgeAcceptance.seed(side),side);await installFrames(page);
      const captures=[],stopAt=Date.now()+4200;
      while(Date.now()<stopAt){
        const shot=await app.evaluate(async({BrowserWindow})=>{
          const w=BrowserWindow.getAllWindows().find((w)=>w.webContents.getURL().includes('renderer/index.html'));
          return {ts:Date.now(),png:(await w.webContents.capturePage()).toPNG().toString('base64')};
        });
        const file=side+'-'+i+'-compositor-'+captures.length+'.png';
        fs.writeFileSync(path.join(OUT,file),Buffer.from(shot.png,'base64'));captures.push({ts:shot.ts,file});await sleep(35);
      }
      const frames=await page.evaluate(()=>{window.__edgeRecording=false;return window.__edgeFrames;});
      const extent=await page.evaluate(()=>{
        const W=spineApp.screen.width,H=spineApp.screen.height,bone=spineObj.skeleton.findBone('F_Chest');
        const core=spineObj.x+spineObj.scale.x*bone.worldX;
        const rt=PIXI.RenderTexture.create({width:W*3,height:H*3});
        try{
          spineApp.renderer.render(spineObj,{renderTexture:rt,clear:true,transform:new PIXI.Matrix(1,0,0,1,W,H)});
          const px=spineApp.renderer.extract.pixels(rt);let min=rt.width,max=-1;
          for(let y=0;y<rt.height;y++)for(let x=0;x<rt.width;x++)if(px[(y*rt.width+x)*4+3]>32){min=Math.min(min,x);max=Math.max(max,x);}
          return {ts:Date.now(),scale:spineObj.scale.x,core,width:W,anim:spineObj.state.getCurrent(0).animation.name,
            leftOfCore:min-W-core,rightOfCore:max-W-core,paddedWidth:rt.width};
        }finally{rt.destroy(true);}
      });
      console.log('PADDED_EXTENT='+JSON.stringify(extent));
      fs.writeFileSync(path.join(OUT,side+'-'+i+'-extent.json'),JSON.stringify(extent,null,2));
      const mains=await app.evaluate(()=>global.__edgeAcceptance.rows);
      const mutations=await app.evaluate(()=>global.__edgeAcceptance.mutations);
      const error=await page.evaluate(()=>window.__edgeFrameError);if(error)throw new Error(error);
      const summary=saveTrial(side,i,frames,mains,captures,mutations);summaries.push(summary);console.log(JSON.stringify(summary));
      fs.writeFileSync(path.join(OUT,side+'-'+i+'-fits.json'),JSON.stringify(await page.evaluate(()=>window.__edgeFits),null,2));
    }
    fs.writeFileSync(path.join(OUT,'summary.json'),JSON.stringify(summaries,null,2));
    await saveOverview(page);
    assert.ok(summaries.every((s)=>s.pass),'body continuity or actual clipping gate failed; see '+OUT);
  }finally{await app.close();}
}
main().catch((e)=>{console.error(e.stack||e);process.exitCode=1;});
