import { ShooterGame } from './shooter.ts';
import { KartGame, KART_THEMES, type KartTheme } from './kart.ts';
import './style.css';
import './controls.css';
import { openGameInputs } from './inputs.ts';
import { h } from '../app/dom.ts';
import { api, type GameCard } from '../app/api.ts';
import { generatedThumb } from '../app/thumbs.ts';
import { t } from '../app/messages.ts';
import { gameInputTools } from '../app/game-inputs.ts';
import { GAMES, readSave, writeSave, type ArcadeEntry } from './catalog.ts';
import { W, H, type Input } from './engine.ts';
import { createGame } from './games.ts';
import { newLevel, readLevels, type ArcadeLevel } from './levels.ts';
import { openBuilder } from './builder.ts';
import { ideaDesk } from './idea-desk.ts';
import { arcadeMotion } from './motion.ts';
import './motion.css';
import './factory.css';
import './kart.css';

const paths: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  prompt: '<path d="M4 4h16v12H9l-5 4Zm4 4h8M8 12h5"/>',
  canvas: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m6 16 5-6 3 4 2-2 3 4M8 7h.01"/>',
  rules: '<path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4"/>',
  latest: '<path d="m5 5 10 7-10 7ZM19 5v14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  spark: '<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6Z"/>',
  shuffle: '<path d="M3 6h3c5 0 7 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 3-2 5-5m2-2c2-3 3-5 5-5h3m-4-4 4 4-4 4"/>',
  volume: '<path d="m11 4-6 5H2v6h3l6 5Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
  mute: '<path d="m11 4-6 5H2v6h3l6 5Zm5 5 6 6m0-6-6 6"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  restart: '<path d="M4 11a8 8 0 1 1 1 6M4 4v7h7"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
  brush: '<path d="m14 3 7 7-10 10-7-7Zm-8 9-3 9 9-3M14 6l4 4"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7Z"/>',
};
function ico(name: string): SVGSVGElement { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ar-icon'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = paths[name] ?? paths.spark; return s; }
function button(text: string, icon: string, fn: () => void, cls = ''): HTMLButtonElement { return h('button', { class: `ar-btn ${cls}`, type: 'button', onclick: fn }, ico(icon), text); }
function iconButton(label: string, glyph: string, fn: () => void, cls = ''): HTMLButtonElement { return h('button', {class:`ar-icon-button ${cls}`,type:'button',title:label,'aria-label':label,onclick:fn},ico(glyph)); }
function thumbnail(entry: ArcadeEntry): HTMLCanvasElement {
  const c = h('canvas', { width: W, height: H, class: `ar-thumbnail ar-thumb-${entry.id}`, 'aria-label': `${entry.title} game preview`, role: 'img' });
  const ctx = c.getContext('2d')!; const g = createGame(entry.id);
  if (entry.id === 'fighter') { const f = g as ReturnType<typeof createGame> & { players: { x: number; attack: number }[] }; f.players[0].x = 418; f.players[1].x = 536; f.players[0].attack = .2; }
  if(g instanceof ShooterGame)g.phase='active';
  g.draw(ctx, 1.4); return c;
}
function shell(): { shell: HTMLElement; main: HTMLElement } {
  const main = h('div', { class: 'ar-main' });
  return { shell: h('div', { class: 'arcade' }, main), main };
}
export function arcadeScreen(root: HTMLElement, _query = new URLSearchParams()): () => void {
  const { shell: page, main } = shell();
  page.classList.add('ar-factory');
  const save = readSave();
  let category = 'All games', search = '';
  let disposed = false;
  const motion = arcadeMotion();
  let published: GameCard[] = [];
  const inputViews: ReturnType<typeof gameInputTools>[] = [];
  const searchInput = h('input', { type: 'search', placeholder: 'Search games', 'aria-label': 'Search games', class: 'ar-search-input' });
  const content = h('div', { class: 'ar-content' }); main.append(content); root.append(page);
  content.append(h('section', { class: 'ar-heading' }, h('h1', null, 'The Game ', h('span', { class: 'factory-name' }, 'Factory')),
    h('a', { class: 'factory-studio', href: '#/studio', 'aria-label': 'Creator Studio' },
      ico('brush'), h('span', { class: 'factory-studio-text' }, 'Creator Studio'),
      h('span', { class: 'factory-studio-arrow', 'aria-hidden': 'true' }, '↗'))));
  const desk = ideaDesk();
  content.append(desk.element);
  const count = h('span', { class: 'ar-game-count', role: 'status', 'aria-live': 'polite' });
  const tabs = h('div', { class: 'ar-tabs', role: 'group', 'aria-label': 'Filter by genre' });
  const grid = h('div', { class: 'ar-game-grid' });
  content.append(h('section', { class: 'ar-games-section', 'aria-label': 'Games to play' },
    h('div', { class: 'ar-section-heading' }, h('h2', null, 'Find your kind of fun', count),
      h('label', { class: 'ar-search' }, ico('search'), searchInput)), tabs, grid));
  const filters = ['All games', 'Action', 'Arcade', 'Adventure', 'Racing'];
  const filterButtons = new Map<string, HTMLButtonElement>();
  function render(): void {
    for (const cat of filters) {
      let filter = filterButtons.get(cat);
      if (!filter) {
        filter = h('button', { type: 'button', class: 'ar-tab', onclick: () => { category = cat; render(); } }, cat === 'All games' ? ico('grid') : null, cat);
        filterButtons.set(cat, filter); tabs.append(filter);
      }
      filter.classList.toggle('active', cat === category);
      filter.setAttribute('aria-pressed', String(cat === category));
    }
    const entries = GAMES.filter(g => (category === 'All games' || category === g.category) && `${g.title} ${g.subtitle} ${g.category}`.toLowerCase().includes(search.toLowerCase()));
    const community = published.filter((g) => (category === 'All games' || category === genre(g)) &&
      `${g.title} ${g.generated?.summary ?? ''} ${genre(g)}`.toLowerCase().includes(search.toLowerCase()));
    count.textContent = String(entries.length + community.length).padStart(2, '0');
    inputViews.splice(0).forEach((input) => input.dispose());
    grid.replaceChildren();
    for (const entry of entries) {
      const favorite = save.favorites.includes(entry.id);
      const fav = h('button', { type: 'button', class: `ar-favorite${favorite ? ' saved' : ''}`,
        title: favorite ? 'Remove from favorites' : 'Add to favorites',
        'aria-label': `${favorite ? 'Unfavorite' : 'Favorite'} ${entry.title}`, 'aria-pressed': String(favorite), onclick: () => {
          const wasSaved = save.favorites.includes(entry.id);
          save.favorites = wasSaved ? save.favorites.filter(id => id !== entry.id) : [...save.favorites, entry.id];
          writeSave(save);
          fav.classList.toggle('saved', !wasSaved);
          fav.title = wasSaved ? 'Add to favorites' : 'Remove from favorites';
          fav.setAttribute('aria-label', `${wasSaved ? 'Favorite' : 'Unfavorite'} ${entry.title}`);
          fav.setAttribute('aria-pressed', String(!wasSaved));
        } }, ico('heart'));
      grid.append(h('article', { class: 'ar-game-card', data: { motionKey: entry.id } }, h('div', { class: 'ar-card-image', style: { backgroundColor: entry.color } },
        h('a', { href: `#/arcade/${entry.id}`, class: 'ar-image-link', 'aria-label': `Play ${entry.title}` }, thumbnail(entry)), h('span', { class: 'ar-card-tag' }, entry.tag), fav,
        h('span', { class: 'ar-image-play', 'aria-hidden': 'true' }, ico('play'))),
        h('div', { class: 'ar-card-body' }, h('span', { class: 'ar-card-category' }, entry.category), h('h3', null, h('a', { href: `#/arcade/${entry.id}` }, entry.title)), h('p', null, entry.subtitle),
          h('div', { class: 'ar-card-bottom' }, h('span', null, ico(entry.id === 'fighter' ? 'bolt' : 'clock'), entry.id === 'fighter' ? 'Solo or with a friend' : 'A perfect little break'), h('a', { class: 'ar-card-go', href: `#/arcade/${entry.id}`, 'aria-label': `Play ${entry.title}` }, ico('arrow'))))));
    }
    for (const game of community) {
      const generated = game.generated!;
      const link = `#/game/${encodeURIComponent(game.id)}?published=1`;
      const inputs = gameInputTools(generated.draft_id, game.title); inputViews.push(inputs);
      grid.append(h('article', { class: 'ar-game-card', data: { motionKey: game.id } },
        h('div', { class: 'ar-card-image ar-generated-cover' },
          h('a', { href: link, class: 'ar-image-link', 'aria-label': `Play ${game.title}` },
            generatedThumb(generated, h('span', { class: 'ar-generated-title' },
              h('span', { class: 'ar-generated-spark', 'aria-hidden': 'true' }, '✦'), h('strong', null, game.title)))),
          h('span', { class: 'ar-card-tag' }, 'COMMUNITY'), h('span', { class: 'ar-image-play', 'aria-hidden': 'true' }, ico('play'))),
        h('div', { class: 'ar-card-body' }, h('span', { class: 'ar-card-category' }, genre(game)),
          h('h3', null, h('a', { href: link }, game.title)), h('p', null, generated.summary ?? ''), inputs.element,
          h('div', { class: 'ar-card-bottom' }, h('span', null, `By ${game.author}`),
            h('a', { class: 'ar-card-go', href: link, 'aria-label': `Play ${game.title}` }, ico('arrow'))))));
    }
    if (!entries.length && !community.length) grid.append(h('div', { class: 'ar-empty' },
      ico('search'), h('h3', null, 'No games found'), h('p', null, 'Try a different name or genre.')));
    motion.watch(grid);
  }
  searchInput.oninput = () => { search = searchInput.value; render(); }; render();
  function genre(game: GameCard): string { return t(`create.category.${game.generated?.category ?? game.brief?.category ?? 'custom'}`); }
  void api.games('new').then(({ games }) => {
    if (disposed) return;
    published = games.filter((game) => game.generated?.status === 'ready' && game.generated.publication === 'published');
    for (const game of published) { const name = genre(game); if (!filters.includes(name)) filters.push(name); }
    render();
  }).catch(() => { /* The starting collection remains playable offline. */ });
  return () => { disposed = true; motion.dispose(); desk?.dispose(); inputViews.forEach((input) => input.dispose()); };
}

export function arcadePlayScreen(root: HTMLElement, id: string): () => void {
  const entry = GAMES.find(g => g.id === id);
  if (!entry) { root.append(h('div', { class: 'arcade ar-empty' }, h('h1', null, 'Game not found'), h('a', { href: '#/' }, 'Back to the arcade'))); return () => {}; }
  const save = readSave(); const { shell: page, main } = shell(); let selectedLevel: ArcadeLevel | null = null; let game = createGame(entry.id), started = false, paused = false, twoPlayer = false, disposed = false, raf = 0, elapsed = 0, accumulator = 0, last = 0, lastScore = 0, resultSaved = false;
  page.classList.add('ar-focused');
  if(entry.id==='kart')page.classList.add('ar-kart');
  if(entry.id==='shooter')page.classList.add('ar-shooter');
  let dialogOpen = false, closeBuilder: (() => void) | null = null, closeInputs: (() => void) | null = null;
  let audio: AudioContext | null = null;
  const input: Input = { down: new Set(), pressed: new Set(), look: { x: 0, y: 0 } };
  const canvas = h('canvas', { class: 'ar-game-canvas', width: W, height: H, tabindex: 0, 'aria-label': `${entry.title}. ${entry.goal}` }); const ctx = canvas.getContext('2d')!;
  const overlay = h('div', { class: 'ar-play-overlay' }); const stage = h('div', { class: 'ar-play-stage' }, canvas, overlay);
  const pause = iconButton('Pause', 'pause', () => togglePause());
  const sound = iconButton(save.muted ? 'Sound on' : 'Sound off', save.muted ? 'mute' : 'volume', () => {
    save.muted = !save.muted; writeSave(save); sound.replaceChildren(ico(save.muted ? 'mute' : 'volume'));
    sound.title = sound.getAttribute('aria-label') === 'Sound on' ? 'Sound off' : 'Sound on'; sound.setAttribute('aria-label', sound.title); if (!save.muted) beep(440);
  });
  const goalText = (): string => entry!.id === 'fighter' ? `Win ${selectedLevel?.rounds ?? 2} rounds. Punch, kick, jump, and block.` : entry!.id === 'racing' ? `Drive ${Math.round(((selectedLevel?.finish ?? 4500) - 100) / 10)} meters to the finish. Collect fuel and balance your car in the air.` : entry!.id === 'shooter' ? `Win ${selectedLevel?.rounds ?? 3} rounds against bots. Eliminate the defenders, or hold E at site A or B for three seconds to plant. Defend the device for 25 seconds; guards can defuse in six. Stop moving for accurate shots.` : entry!.id === 'kart' ? entry!.goal.replace('three-lap', `${selectedLevel?.kartLaps ?? 3}-lap`) : entry!.goal;
  const goal = h('p', null, goalText());
  const rules = h('dialog', {class:'arcade ar-rules-dialog'});
  rules.append(h('div', {class:'ar-rules-top'}, h('h2',null,'Game rules'), iconButton('Close rules','close',()=>rules.close())),
    goal, h('div',{class:'ar-keys'},...entry.keys.map(k=>h('div',null,h('kbd',null,k.key),h('span',null,k.action))),h('div',null,h('kbd',null,'P / ESC'),h('span',null,'Pause'))));
  if (entry.id === 'fighter') {
    const modes = h('div', {class:'ar-modes',role:'group','aria-label':'Fighter mode'});
    const renderModes = (): void => { modes.replaceChildren(...[false,true].map(mode=>h('button',{type:'button',class:`ar-mode${twoPlayer===mode?' active':''}`,'aria-pressed':String(twoPlayer===mode),onclick:()=>{twoPlayer=mode;reset();renderModes();}},mode?'With a friend':'Vs. computer'))); }; renderModes();
    rules.append(modes,h('p',null,'Player 2: ← → move · ↑ jump · ↓ block · K punch · L kick.'));
  }
  document.body.append(rules);
  rules.addEventListener('close',()=>{dialogOpen=false;});
  const suspend = (): void => { releaseAim(); clearInput(); if(started&&!game.over){paused=true;showOverlay();} dialogOpen=true; };
  const levels = h('div', {class:'ar-custom-levels',role:'group','aria-label':'Game levels'});
  const latest = iconButton('Play latest level','latest',()=>{
    const level = readLevels(entry!.id).at(-1); if(!level)return;selectedLevel=level;reset();renderLevels();start();
  });
  const editLevel = (): void => {
    suspend();
    const source = selectedLevel ?? newLevel(entry!.id, readLevels(entry!.id).length+1);
    const editable = source.game === 'kart' && /^kart-(alpine|sunset)$/.test(source.id) ? { ...source, id: crypto.randomUUID() } : source;
    closeBuilder = openBuilder(editable, level=>{selectedLevel=level;reset();renderLevels();},()=>{dialogOpen=false;closeBuilder=null;});
  };
  const addLevel = (): void => {
    suspend();
    closeBuilder = openBuilder(newLevel(entry!.id,readLevels(entry!.id).length+1),level=>{selectedLevel=level;reset();renderLevels();},()=>{dialogOpen=false;closeBuilder=null;});
  };
  const openInputs = (): void => {
    suspend();closeInputs=openGameInputs(entry,selectedLevel,()=>{dialogOpen=false;closeInputs=null;});
  };
  const inputTools = iconButton('Prompt & canvas','canvas',openInputs);
  const rail=h('nav',{class:'ar-game-rail','aria-label':'Game tools'},
    iconButton('Add a level','plus',addLevel,'ar-add-level'),latest,iconButton('Edit level','brush',editLevel),iconButton('Game rules','rules',()=>{suspend();goal.textContent=goalText();rules.showModal();}),inputTools);
  main.append(h('header',{class:'ar-minimal-head'},h('a',{class:'ar-icon-button',href:'#/','aria-label':'Back to arcade',title:'Back to arcade'},ico('back')),h('h1',null,entry.title),h('a',{href:'#/',class:'ar-minimal-brand'},'The Game Factory')));
  const content=h('div',{class:'ar-content ar-player-content'},h('div',{class:'ar-game-layout'},stage,rail),
    h('div',{class:'ar-play-toolbar'},h('div',{class:'ar-play-actions'},pause,iconButton('Restart','restart',()=>reset()),sound,iconButton('Fullscreen','expand',()=>{
      if(document.fullscreenElement)void document.exitFullscreen();else if(stage.requestFullscreen)void stage.requestFullscreen().then(()=>canvas.focus({preventScroll:true})).catch(()=>{stage.classList.toggle('ar-expanded');syncFullscreen();});else {stage.classList.toggle('ar-expanded');syncFullscreen();}
    }))),levels);
  main.append(content);root.append(page);
  function renderLevels(): void {
    const saved=readLevels(entry!.id); latest.disabled=!saved.length;
    const circuits: ArcadeLevel[] = entry!.id === 'kart' ? (['alpine', 'sunset'] as KartTheme[]).map(theme => ({ id: `kart-${theme}`, game: 'kart', name: KART_THEMES[theme].name, kartTheme: theme, kartLaps: 3, source: { prompt: 'As one of the stock games can you add game exactly like mario cart with great graphics.' } })) : [];
    const items: (ArcadeLevel|null)[]=[null,...circuits,...saved];
    levels.replaceChildren(...items.map((level,index)=>{
      const thumb=h('canvas',{width:W,height:H,'aria-hidden':'true'});createGame(entry!.id,false,level).draw(thumb.getContext('2d')!,1.4);
      const name = level?.name ?? (entry!.id === 'kart' ? KART_THEMES.coast.name : 'Original level');
      return h('button',{type:'button',class:`ar-level-preview${selectedLevel?.id===level?.id?' active':''}`,'aria-label':name,'aria-pressed':String(selectedLevel?.id===level?.id),title:name,onclick:()=>{selectedLevel=level;reset();renderLevels();}},thumb,h('span',null,String(index+1)),entry!.id === 'kart' ? h('small', null, name) : null);
    }),iconButton('Add a level','plus',addLevel,'ar-level-new'));
  }
  renderLevels();
  const touch = h('div', { class: 'ar-touch', 'aria-label': 'Touch game controls' });
  entry.touch.forEach(control => { const b = h('button', { type: 'button', class: 'ar-touch-key', 'aria-label': control.label }, control.label); b.onpointerdown = e => { e.preventDefault(); b.setPointerCapture(e.pointerId); if (!input.down.has(control.key)) input.pressed.add(control.key); input.down.add(control.key); b.classList.add('held'); }; const up = () => { input.down.delete(control.key); b.classList.remove('held'); }; b.onpointerup = up; b.onpointercancel = up; b.onlostpointercapture = up; touch.append(b); }); content.append(touch);
  const exitFullscreen = iconButton('Exit fullscreen', 'close', () => { if (document.fullscreenElement) void document.exitFullscreen(); else { stage.classList.remove('ar-expanded'); syncFullscreen(); } }, 'ar-fullscreen-exit'); stage.append(exitFullscreen);
  function syncFullscreen(): void { if (document.fullscreenElement === stage || stage.classList.contains('ar-expanded')) stage.append(touch); else content.append(touch); canvas.focus({ preventScroll: true }); }
  document.addEventListener('fullscreenchange', syncFullscreen);
  function beep(freq: number): void {
    if (save.muted) return;
    try { audio ??= new AudioContext(); void audio.resume(); const oscillator = audio.createOscillator(), gain = audio.createGain(); oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(freq, audio.currentTime); oscillator.frequency.exponentialRampToValueAtTime(freq * 1.4, audio.currentTime + .07); gain.gain.setValueAtTime(.035, audio.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .12); oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + .13); } catch { /* Audio is optional. */ }
  }
  function shooterSound(event: ShooterGame['soundEvents'][number]): void {
    if(save.muted)return;
    if(event!=='shot'){beep(event==='hit'?760:event==='plant'?960:event==='reload'?190:event==='round'?440:100);return;}
    try {
      audio??=new AudioContext();void audio.resume();
      const buffer=audio.createBuffer(1,Math.floor(audio.sampleRate*.085),audio.sampleRate),data=buffer.getChannelData(0);
      for(let n=0;n<data.length;n++)data[n]=(Math.random()*2-1)*Math.exp(-n/data.length*6);
      const source=audio.createBufferSource(),filter=audio.createBiquadFilter(),gain=audio.createGain();source.buffer=buffer;filter.type='lowpass';filter.frequency.value=2100;gain.gain.value=.18;
      source.connect(filter);filter.connect(gain);gain.connect(audio.destination);source.start();
    }catch{ /* Sound remains optional. */ }
  }
  let lookPointer: number | null=null, lookX=0,lookY=0;
  const canAim=():boolean=>game instanceof ShooterGame&&started&&!paused&&!game.over&&!dialogOpen&&game.phase==='active'&&game.hp>0;
  function releaseAim(): void { if(document.pointerLockElement===canvas)document.exitPointerLock();lookPointer=null; }
  const aimDown=(e:PointerEvent):void=>{
    if(!canAim()||e.button!==0)return;
    e.preventDefault();canvas.focus({preventScroll:true});lookX=e.clientX;lookY=e.clientY;
    if(e.pointerType==='mouse'){
      input.down.add('Mouse0');input.pressed.add('Mouse0');
      try { const request=canvas.requestPointerLock?.(); if(request&&typeof request.catch==='function')void request.catch(()=>{}); }catch{ /* Drag aiming remains available. */ }
    }else {lookPointer=e.pointerId;canvas.setPointerCapture(e.pointerId);}
  };
  const aimMove=(e:PointerEvent):void=>{
    if(!canAim()||document.pointerLockElement===canvas)return;
    const bounds=canvas.getBoundingClientRect();
    if(e.pointerType==='mouse'){input.look!.x+=e.movementX*W/bounds.width;input.look!.y+=e.movementY*H/bounds.height;return;}
    if(lookPointer!==e.pointerId)return;
    input.look!.x+=(e.clientX-lookX)*W/bounds.width;input.look!.y+=(e.clientY-lookY)*H/bounds.height;lookX=e.clientX;lookY=e.clientY;
  };
  const aimUp=(e:PointerEvent):void=>{input.down.delete('Mouse0');if(lookPointer===e.pointerId)lookPointer=null;};
  const lockedMove=(e:MouseEvent):void=>{if(canAim()&&document.pointerLockElement===canvas){input.look!.x+=e.movementX;input.look!.y+=e.movementY;}};
  const lockChange=():void=>{if(document.pointerLockElement!==canvas&&canAim()){input.down.delete('Mouse0');paused=true;clearInput();showOverlay();}};
  canvas.addEventListener('pointerdown',aimDown);canvas.addEventListener('pointermove',aimMove);canvas.addEventListener('pointercancel',aimUp);document.addEventListener('pointerup',aimUp);document.addEventListener('mousemove',lockedMove);document.addEventListener('pointerlockchange',lockChange);
  function clearInput(): void { input.down.clear(); input.pressed.clear(); if(input.look)input.look.x=input.look.y=0; touch.querySelectorAll('button').forEach(b => b.classList.remove('held')); }
  function remember(): void { if (!selectedLevel && game.score > (save.best[entry!.id] ?? 0)) { save.best[entry!.id] = game.score; writeSave(save); } }
  function start(): void { started = true; paused = false; overlay.hidden = true; save.recent = [entry!.id, ...save.recent.filter(x => x !== entry!.id)].slice(0, GAMES.length); writeSave(save); canvas.focus({ preventScroll: true }); clearInput(); showOverlay(); beep(330); }
  function reset(): void { releaseAim(); remember(); canvas.setAttribute('aria-label', `${entry!.title}. ${selectedLevel?.name ?? 'Original level'}. ${goalText()}`); game = createGame(entry!.id, twoPlayer, selectedLevel); started = false; paused = false; resultSaved = false; lastScore = 0; accumulator = 0; elapsed = 0; clearInput(); showOverlay(); }
  function togglePause(): void { if (!started || game.over) return; paused = !paused; if(paused)releaseAim(); clearInput(); showOverlay(); if (!paused) canvas.focus({ preventScroll: true }); }
  function showOverlay(): void {
    const visible = !started || paused || game.over; overlay.hidden = !visible;
    pause.replaceChildren(ico(paused ? 'play' : 'pause')); pause.title=paused?'Resume':'Pause';pause.setAttribute('aria-label',pause.title);pause.disabled=!started||game.over;
    if (!visible) return;
    const box=h('div',{class:'ar-simple-overlay'},game.over?h('div',{class:'ar-simple-result'},h('span',{'aria-label':game.won?'Level cleared':'Game over'},game.won?'✦':'↻'),h('strong',null,String(game.score))):'');
    if (game instanceof KartGame) {
      if (game.over) box.append(h('p', { class: 'ar-kart-result', role: 'status' }, game.info));
      else if (!started) box.append(h('p', { class: 'ar-kart-help' }, '↑ Gas · ← → Steer · Shift Drift · Space Item'));
    }
    box.append(button(game.over?'Play again':paused?'Resume':'Play','play',()=>{if(game.over){reset();start();}else if(paused)togglePause();else start();},'ar-start-btn'));
    overlay.replaceChildren(box);
  }
  const keys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'KeyF', 'KeyG', 'KeyK', 'KeyL', 'ShiftLeft', 'ShiftRight', 'KeyR', 'KeyE', 'Digit1', 'Digit2', 'Digit3', 'Enter']);
  const keydown = (e: KeyboardEvent): void => {
    if (dialogOpen || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) return;
    if (!started && (e.code === 'Enter' || e.code === 'Space')) { e.preventDefault(); start(); return; }
    if (e.code === 'Escape' || e.code === 'KeyP') { e.preventDefault(); if (!e.repeat) togglePause(); return; }
    if (keys.has(e.code)) { e.preventDefault(); if (started && !paused && !game.over) { if (!input.down.has(e.code)) input.pressed.add(e.code); input.down.add(e.code); } }
  };
  const keyup = (e: KeyboardEvent): void => { input.down.delete(e.code); };
  const blur = (): void => { releaseAim(); clearInput(); if (started && !game.over && !paused) { paused = true; showOverlay(); } };
  const visibility = (): void => { if (document.hidden) blur(); };
  window.addEventListener('keydown', keydown); window.addEventListener('keyup', keyup); window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility);
  function frame(now: number): void {
    if (disposed) return; const dt = last ? Math.min(.05, (now - last) / 1000) : 0; last = now;
    if (started && !paused && !game.over && !dialogOpen) {
      accumulator += dt; while (accumulator >= 1 / 120 && !game.over) { game.update(1 / 120, input); input.pressed.clear(); accumulator -= 1 / 120; elapsed += 1 / 120; }
      if (game instanceof ShooterGame) { for(const event of game.soundEvents.splice(0))shooterSound(event); }
      if (game instanceof KartGame) { for (const event of game.soundEvents.splice(0)) beep(event === 'count' ? 300 : event === 'go' ? 880 : event === 'hit' ? 120 : event === 'boost' ? 620 : event === 'finish' ? 1040 : 760); }
      if (!(game instanceof ShooterGame) && !(game instanceof KartGame) && game.score > lastScore) { beep(520 + (game.score % 4) * 70); lastScore = game.score; }
      if (game.over && !resultSaved) { resultSaved = true; releaseAim(); remember(); clearInput(); showOverlay(); }
    }
    game.draw(ctx, started ? elapsed : now / 1000);

    raf = requestAnimationFrame(frame);
  }
  showOverlay(); raf = requestAnimationFrame(frame);
  return () => { disposed = true; releaseAim(); canvas.removeEventListener('pointerdown',aimDown);canvas.removeEventListener('pointermove',aimMove);canvas.removeEventListener('pointercancel',aimUp);document.removeEventListener('pointerup',aimUp);document.removeEventListener('mousemove',lockedMove);document.removeEventListener('pointerlockchange',lockChange); document.removeEventListener('fullscreenchange', syncFullscreen); closeBuilder?.(); closeInputs?.(); rules.remove(); cancelAnimationFrame(raf); remember(); clearInput(); window.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility); if (audio) void audio.close(); if (document.fullscreenElement === stage) void document.exitFullscreen(); };
}
