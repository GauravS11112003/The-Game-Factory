/** The iframe receives game commands only; credentials and networking stay in the parent. */
export function roomDocument(html: string, nonce: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;
  const bridge = `<script>(()=>{
    const nonce=${JSON.stringify(nonce)}; let round=0, host=false, started=false, paused=true, adapter=null, announced=false;
    const emit=(type,data={})=>parent.postMessage({channel:'draw-play-room',nonce,type,round,...data},'*');
    const api=()=>window.drawPlayMultiplayer;
    function ready(){ const a=api(); return window.drawPlayGame?.ready && a?.version===1 && ['start','input','snapshot','restore','pause','result'].every(k=>typeof a[k]==='function'); }
    let attempts=0;
    const poll=setInterval(()=>{ if(ready()){ adapter=api(); adapter.pause(true); clearInterval(poll); announced=true; emit('ready'); }else if(++attempts>=200){clearInterval(poll);emit('error',{message:'This game needs a multiplayer repair. Ask the builder to fix the two-player controls.'});}},100);
    addEventListener('message',event=>{
      if(event.source!==parent || event.data?.channel!=='draw-play-room' || event.data?.nonce!==nonce)return;
      const m=event.data;
      if(m.type==='hello' && announced){emit('ready');return;}
      if(!adapter)return;
      try{
        if(m.type==='start'){
          round=m.round;host=m.seat===0;paused=true;started=true;
          adapter.start({seat:m.seat,isHost:host,seed:m.seed});adapter.pause(true);
          if(m.world)adapter.restore(m.world);
        } else if(m.type==='state' && started && m.round===round){
          if(m.world)adapter.restore(m.world);
          if(host && Array.isArray(m.inputs)){adapter.input(0,m.inputs[0]||[]);adapter.input(1,m.inputs[1]||[]);}
          paused=m.paused;adapter.pause(paused);
        } else if(m.type==='pause'){paused=true;adapter.pause(true);if(host){adapter.input(0,[]);adapter.input(1,[]);}}
      }catch(error){paused=true;adapter.pause(true);emit('error',{message:'The game could not synchronize. Ask the builder to repair multiplayer.'});}
    });
    setInterval(()=>{
      if(!started||!host||paused||!adapter)return;
      try{const world=adapter.snapshot();if(!world||typeof world!=='object'||Array.isArray(world)||JSON.stringify(world).length>48000)throw Error();emit('world',{world});const result=adapter.result();if(result)emit('finish',{result});}
      catch(error){paused=true;adapter.pause(true);emit('error',{message:'The shared game state could not be saved. Ask the builder to repair multiplayer snapshots.'});}
    },100);
  })();</script>`;
  // Put the restrictive policy first, including for malformed documents without a head.
  return csp + (/<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${bridge}</body>`) : html + bridge);
}
