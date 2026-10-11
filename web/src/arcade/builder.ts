import { ShooterGame, BLUEPRINT, ARENA_COLS, ARENA_ROWS, solid } from './shooter.ts';
import { h } from '../app/dom.ts';
import { drawLevelInput, captureLevelInputs } from './level-source.ts';
import { W, H } from './engine.ts';
import { saveLevel, type ArcadeLevel } from './levels.ts';

type Tool = 'wall' | 'dot' | 'power' | 'platform' | 'coin' | 'enemy' | 'hill' | 'fuel' | 'flag' | 'blue' | 'coral' | 'erase' | 'cover' | 'entry' | 'guard' | 'siteA' | 'siteB';
const symbols: Record<Tool, string> = { wall: '▦', dot: '·', power: '◉', platform: '▰', coin: '●', enemy: '♟', hill: '∿', fuel: '▣', flag: '⚑', blue: '①', coral: '②', erase: '⌫', cover: '▣', entry: 'P', guard: 'D', siteA: 'A', siteB: 'B' };
const names: Record<Tool, string> = {wall:'Wall',dot:'Dot',power:'Power pellet',platform:'Platform',coin:'Coin',enemy:'Enemy',hill:'Shape hills',fuel:'Fuel can',flag:'Finish flag',blue:'Blue player start',coral:'Coral player start',erase:'Erase',cover:'Crate cover',entry:'Player entry',guard:'Defender',siteA:'Bomb site A',siteB:'Bomb site B'};
export function openBuilder(source: ArcadeLevel, onSave: (level: ArcadeLevel) => void, onClose: () => void = () => {}): () => void {
  let draft = structuredClone(source), screen = 0, tool: Tool = draft.arena ? 'wall' : draft.maze ? 'wall' : draft.platforms ? 'platform' : draft.hills ? 'hill' : 'blue';
  const history: ArcadeLevel[] = [], future: ArcadeLevel[] = [];
  const canvas = h('canvas', {width:W,height:H,class:'ar-builder-canvas','aria-label':'Level canvas. Choose a tool and click to place it.',tabindex:0});
  const ctx = canvas.getContext('2d')!;
  const dialog = h('dialog', {class:'ar-builder-dialog arcade'});
  const title = h('input', {class:'ar-level-name',value:draft.name,maxLength:40,'aria-label':'Level name'});
  const status = h('span', {class:'ar-builder-status',role:'status'});
  function command(label: string, symbol: string, run: () => void): HTMLButtonElement { return h('button',{type:'button',class:'ar-icon-button',title:label,'aria-label':label,onclick:run},symbol); }
  function close(): void { dialog.close(); dialog.remove(); }
  const undo = command('Undo','↶',()=>{if(!history.length)return;future.push(structuredClone(draft));draft=history.pop()!;title.value=draft.name;draw();});
  const redo = command('Redo','↷',()=>{if(!future.length)return;history.push(structuredClone(draft));draft=future.pop()!;title.value=draft.name;draw();});
  function checkpoint(): void { draft.name=title.value.trim()||draft.name; history.push(structuredClone(draft)); if(history.length>100)history.shift(); future.length=0; }
  const toolset: Tool[] = draft.arena ? ['wall','cover','entry','guard','siteA','siteB','erase'] : draft.maze ? ['wall','dot','power','erase'] : draft.platforms ? ['platform','coin','enemy','flag','erase'] : draft.hills ? ['hill','fuel','coin','flag','erase'] : ['blue','coral'];
  const tools = h('div',{class:'ar-builder-tools',role:'group','aria-label':'Building tools'});
  function renderTools(): void { tools.replaceChildren(...toolset.map(t=>h('button',{type:'button',class:`ar-icon-button${tool===t?' active':''}`,title:names[t],'aria-label':names[t],'aria-pressed':String(tool===t),onclick:()=>{tool=t;renderTools();}},symbols[t]))); }
  renderTools();
  const pages = h('div',{class:'ar-builder-pages',role:'group','aria-label':'World section'});
  const pageCount = draft.platforms ? 4 : draft.hills ? 5 : 1;
  function renderPages(): void { pages.replaceChildren(...Array.from({length:pageCount},(_,n)=>h('button',{type:'button',class:`ar-icon-button${screen===n?' active':''}`,'aria-label':`Section ${n+1}`,'aria-pressed':String(screen===n),onclick:()=>{screen=n;renderPages();draw();}},String(n+1)))); }
  if(pageCount>1)renderPages();
  const settings = h('div',{class:'ar-builder-settings'});
  if(draft.game==='fighter'||draft.game==='shooter') {
    const duration = h('input',{type:'range',min:15,max:180,step:15,value:draft.duration,'aria-label':'Round duration in seconds'});
    const rounds = h('input',{type:'range',min:1,max:5,step:1,value:draft.rounds,'aria-label':'Rounds to win'});
    const durationValue=h('output',null,`${draft.duration}s`),roundsValue=h('output',null,String(draft.rounds));
    duration.onchange=()=>{checkpoint();draft.duration=Number(duration.value);durationValue.textContent=`${draft.duration}s`;draw();};
    rounds.onchange=()=>{checkpoint();draft.rounds=Number(rounds.value);roundsValue.textContent=String(draft.rounds);draw();};
    settings.append(h('label',{title:'Round duration'},'◷',duration,durationValue),h('label',{title:'Rounds to win'},'⚑',rounds,roundsValue));
  }
  const save = h('button',{type:'button',class:'ar-btn ar-builder-save',onclick:()=>{
    draft.name=title.value.trim()||source.name;
    const error=validate();
    if(error){status.textContent=error;return;}
    try {draft.source={...draft.source,inputCanvases:captureLevelInputs(draft)};saveLevel(draft);onSave(draft);close();}catch{status.textContent='Could not save. Free up device storage and try again.';}
  }},'Save');
  dialog.append(h('div',{class:'ar-builder-top'},title,h('div',{class:'ar-builder-commands'},undo,redo,save,command('Close builder','×',close))),
    h('div',{class:'ar-builder-workspace'},canvas,tools),h('div',{class:'ar-builder-bottom'},pages,settings,status));
  document.body.append(dialog); dialog.showModal(); draw();
  dialog.addEventListener('close',()=>{dialog.remove();onClose();});
  function draw(): void {
    drawLevelInput(ctx,draft,screen);undo.disabled=!history.length;redo.disabled=!future.length;
  }
  canvas.addEventListener('pointerdown',e=>{
    const r=canvas.getBoundingClientRect(),x=(e.clientX-r.left)/r.width*W,y=(e.clientY-r.top)/r.height*H,wx=Math.round((x+screen*W)/40)*40,wy=Math.max(120,Math.min(500,Math.round(y/20)*20));
    status.textContent='';
    if(draft.arena){
      const col=Math.floor((x-BLUEPRINT.x)/BLUEPRINT.tile),row=Math.floor((y-BLUEPRINT.y)/BLUEPRINT.tile);
      if(col<=0||col>=ARENA_COLS-1||row<=0||row>=ARENA_ROWS-1)return;
      checkpoint();
      const tile=tool==='wall'?'1':tool==='cover'?'3':tool==='entry'?'P':tool==='guard'?'D':tool==='siteA'?'A':tool==='siteB'?'B':'.';
      if('PAB'.includes(tile))draft.arena=draft.arena.map(r=>r.replaceAll(tile,'.'));
      const tiles=[...draft.arena[row]];tiles[col]=tile;draft.arena[row]=tiles.join('');
    }else if(draft.maze){
      const col=Math.round((x-165)/30),row=Math.round((y-58)/30);
      if(col<=0||col>=20||row<=0||row>=14)return;
      // Starts stay open so every maze has somewhere to spawn.
      if([[10,11],[9,7],[10,7],[11,7],[10,9]].some(([cx,cy])=>cx===col&&cy===row))return;
      checkpoint();const tiles=[...draft.maze[row]];tiles[col]=tool==='wall'?'#':tool==='power'?'o':tool==='dot'?'.':' ';draft.maze[row]=tiles.join('');
    } else if(draft.platforms){
      checkpoint();
      if(tool==='platform')draft.platforms.push({x:Math.max(0,wx-80),y:wy,w:160,h:30});
      if(tool==='coin')draft.coins!.push({x:wx,y:wy});
      if(tool==='enemy')draft.enemies!.push({x:wx,y:wy});
      if(tool==='flag')draft.finish=Math.max(400,Math.min(3700,wx));
      if(tool==='erase'){
        const c=draft.coins!.findIndex(p=>Math.hypot(p.x-wx,p.y-wy)<45),en=draft.enemies!.findIndex(p=>Math.hypot(p.x-wx,p.y-wy)<55);
        if(c>=0)draft.coins!.splice(c,1);else if(en>=0)draft.enemies!.splice(en,1);else {const p=draft.platforms.map((p,i)=>wx>=p.x&&wx<=p.x+p.w&&y>=p.y-12&&y<=p.y+p.h?i:-1).filter(i=>i>=0).pop();if(p!==undefined)draft.platforms.splice(p,1);}
      }
    }else if(draft.hills){
      checkpoint();
      if(tool==='hill'){const point=draft.hills.reduce((a,b)=>Math.abs(b.x-wx)<Math.abs(a.x-wx)?b:a);point.y=wy;}
      if(tool==='fuel'||tool==='coin'){draft.pickups=draft.pickups!.filter(p=>Math.abs(p.x-wx)>25);draft.pickups.push({x:wx,fuel:tool==='fuel'});}
      if(tool==='flag')draft.finish=Math.max(500,Math.min(4700,wx));
      if(tool==='erase')draft.pickups=draft.pickups!.filter(p=>Math.abs(p.x-wx)>45);
    }else {checkpoint();draft.spawns![tool==='blue'?0:1]=Math.max(55,Math.min(905,Math.round(x)));}
    draw();
  });
  function validate(): string | null {
    if(draft.arena){
      const all=draft.arena.join('');
      if(!['P','A','B'].every(t=>[...all].filter(c=>c===t).length===1))return 'Place a player entry and both bomb sites.';
      const count=all.match(/D/g)?.length??0;
      if(count<1||count>6)return 'Place one to six defenders.';
      const map=new ShooterGame(draft.arena);
      for(const target of [...map.sites,...map.guards])if(!map.route(map.x,map.y,target.x,target.y).length&&Math.hypot(target.x-map.x,target.y-map.y)>1)return 'Connect the entry to every site and defender.';
      if(draft.arena.some((r,y)=>[...r].some((v,x)=>(x===0||y===0||x===ARENA_COLS-1||y===ARENA_ROWS-1)&&!solid(v))))return 'Keep the outside walls closed.';
    }
    if(draft.maze){
      const cells=new Set<string>(),todo=[[10,11]];
      while(todo.length){const [x,y]=todo.pop()!;const key=`${x},${y}`;if(cells.has(key)||!draft.maze[y]?.[x]||draft.maze[y][x]==='#')continue;cells.add(key);todo.push([x+1,y],[x-1,y],[x,y+1],[x,y-1]);}
      let dots=0;
      for(const [y,row]of draft.maze.entries())for(const [x,tile]of [...row].entries())if(tile==='.'||tile==='o'){dots++;if(!cells.has(`${x},${y}`))return 'Connect every dot to the player’s path.';}
      if(!dots)return 'Add at least one dot.';
    }
    if(draft.platforms){
      const supported=(x:number)=>draft.platforms!.some(p=>x>=p.x&&x<=p.x+p.w);
      if(!supported(75))return 'Add a platform beneath the player start.';
      if(!supported(draft.finish!))return 'Place the finish flag above a platform.';
    }
    if(draft.spawns&&Math.abs(draft.spawns[0]-draft.spawns[1])<100)return 'Place the fighters farther apart.';
    return null;
  }
  return close;
}
