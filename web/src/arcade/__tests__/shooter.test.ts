import { describe, expect, it, vi, afterEach } from 'vitest';
import { ShooterGame, castRay, SHOOTER_MAP, solid } from '../shooter.ts';
import { createGame } from '../games.ts';
import { newLevel, readLevels, saveLevel } from '../levels.ts';
import type { Input } from '../engine.ts';
const input = (...keys:string[]):Input => ({down:new Set(keys),pressed:new Set(keys),look:{x:0,y:0}});
function advance(g:ShooterGame, seconds:number, keys:string[]=[]):void {
  const i=input(...keys);for(let n=0;n<Math.ceil(seconds*120);n++){g.update(1/120,i);i.pressed.clear();}
}
function active():ShooterGame { const g=new ShooterGame();g.phase='active';return g; }
function quiet(g:ShooterGame):void {g.guards.forEach(d=>{d.cooldown=1000;});}
afterEach(()=>vi.unstubAllGlobals());
describe('Breach Point tactical shooter',()=>{
  it('connects the entry to both sites and every defender without walking through cover',()=>{
    const g=active();for(const goal of [...g.sites,...g.guards]){
      const path=g.route(g.x,g.y,goal.x,goal.y);expect(path.length).toBeGreaterThan(0);
      expect(path.every(p=>!solid(g.map[Math.floor(p.y)][Math.floor(p.x)]))).toBe(true);
      expect(path.at(-1)).toEqual({x:goal.x,y:goal.y});
    }
  });
  it('casts exact wall intersections and blocks sight and bullets behind cover',()=>{
    const g=active();g.x=3.5;g.y=10.5;g.angle=0;
    expect(castRay(g.map,g.x,g.y,0).distance).toBeCloseTo(.5);expect(g.sight(g.x,g.y,7.5,10.5)).toBe(false);
    const d=g.guards[0];d.x=7.5;d.y=10.5;g.guards=[d];g.shoot();expect(d.hp).toBe(85);expect(g.ammo.rifle).toBe(29);
  });
  it('slides along walls, normalizes diagonal speed, and supports precise mouse aim',()=>{
    const g=active();quiet(g);g.x=3.7;g.y=10.5;g.angle=-Math.PI/2;
    const i=input('KeyD','KeyW');i.look={x:20,y:-20};g.update(.1,i);
    expect(g.x).toBeLessThan(3.8);expect(g.y).toBeLessThan(10.5);expect(g.pitch).toBe(13);expect(i.look).toEqual({x:0,y:0});
    const a=active(),b=active();quiet(a);quiet(b);const ax=a.x,ay=a.y;
    a.update(.1,input('KeyW'));b.update(.1,input('KeyW','KeyD'));
    expect(Math.hypot(a.x-ax,a.y-ay)).toBeCloseTo(Math.hypot(b.x-ax,b.y-ay));
  });
  it('requires hits on visible defenders and gives headshots and body shots different damage',()=>{
    const g=active();const d=g.guards[0];d.x=3.5;d.y=12.5;g.guards=[d];g.shoot();expect(d.hp).toBe(51);
    g.cooldown=0;g.recoil=0;g.pitch=120;g.shoot();expect(d.hp).toBe(0);expect(g.score).toBe(150);expect(g.headMarker).toBe(true);
    g.cooldown=0;g.shoot();expect(g.score).toBe(150);
  });
  it('conserves reserve ammunition, enforces reload timing, and prevents switching during reload',()=>{
    const g=active();quiet(g);g.ammo.rifle=4;g.reserve.rifle=10;g.reload();g.update(.1,input('Digit2'));
    expect(g.weapon).toBe('rifle');expect(g.ammo.rifle).toBe(4);g.shoot();expect(g.ammo.rifle).toBe(4);
    advance(g,1.8);expect(g.ammo.rifle).toBe(14);expect(g.reserve.rifle).toBe(0);expect(g.reloading).toBeNull();
    g.reload();expect(g.reloading).toBeNull();
  });
  it('fires short taps even when the key is released before the next frame',()=>{
    const g=active(),i=input('Space');i.down.clear();g.update(1/120,i);expect(g.ammo.rifle).toBe(29);
    const angle=g.angle,turn=input('ArrowRight');turn.down.clear();g.update(1/120,turn);expect(g.angle-angle).toBeCloseTo(.08);
  });
  it('makes buying and deployment use credits only during the buy phase',()=>{
    const g=new ShooterGame();g.rifleOwned=false;g.money=2200;g.armor=0;g.update(.01,input('Digit1','Digit3'));
    expect(g.money).toBe(0);expect(g.rifleOwned).toBe(true);expect(g.armor).toBe(80);
    g.update(.01,input('Enter'));expect(g.phase).toBe('active');g.armor=0;g.update(.01,input('Digit3'));expect(g.armor).toBe(0);
  });
  it('requires three uninterrupted stationary seconds to plant and resets on release or movement',()=>{
    const g=active();quiet(g);g.x=g.sites[0].x;g.y=g.sites[0].y;advance(g,1,['KeyE']);expect(g.bomb).toBeNull();
    g.update(.01,input());expect(g.plantProgress).toBe(0);advance(g,1,['KeyE']);g.update(.01,input('KeyE','KeyW'));expect(g.plantProgress).toBe(0);
    g.x=g.sites[0].x;g.y=g.sites[0].y;advance(g,3.1,['KeyE']);expect(g.bomb?.name).toBe('A');expect(g.score).toBe(200);
  });
  it('allows the planted device to win after the player is down and round time expires',()=>{
    const g=active();g.hp=0;g.timer=.01;g.bomb={...g.sites[0]};g.bombTimer=.02;
    g.guards.forEach(d=>{d.x=20.5;d.y=15.5;});advance(g,.04);
    expect(g.wins).toBe(1);expect(g.roundMessage).toBe('OBJECTIVE COMPLETE');
  });
  it('lets defenders follow cover routes and defuse the device in six seconds',()=>{
    const g=active();quiet(g);g.hp=0;g.bomb={...g.sites[0]};g.bombTimer=25;
    const d=g.guards[0];d.x=g.bomb.x;d.y=g.bomb.y;g.guards=[d];advance(g,6.1);
    expect(g.losses).toBe(1);expect(g.roundMessage).toBe('DEVICE DEFUSED');
    const chaser=active();chaser.hp=0;chaser.bomb={...chaser.sites[0]};const before=chaser.guards.map(d=>({x:d.x,y:d.y}));advance(chaser,2);
    expect(chaser.guards.some((d,n)=>Math.hypot(d.x-before[n].x,d.y-before[n].y)>.5)).toBe(true);
    expect(chaser.guards.every(d=>chaser.free(d.x,d.y))).toBe(true);
  });
  it('interrupts a defuse when the defender is hit',()=>{
    const g=active(),d=g.guards[0];g.x=3.5;g.y=14.5;d.x=3.5;d.y=12.5;g.defuser=d;g.defuseProgress=5;g.shoot();
    expect(g.defuseProgress).toBe(0);expect(g.defuser).toBeNull();
  });
  it('ends rounds on timeout or death and resets gear according to survival',()=>{
    const g=active();quiet(g);g.timer=.001;g.update(.01,input());expect(g.roundMessage).toBe('TIME EXPIRED');g.nextRound();expect(g.rifleOwned).toBe(true);
    g.phase='active';g.hp=0;g.update(.01,input());expect(g.roundMessage).toBe('ROUND LOST');g.nextRound();expect(g.weapon).toBe('pistol');expect(g.rifleOwned).toBe(false);expect(g.armor).toBe(0);
  });
  it('wins the first-to-three match and does not keep adding score after completion',()=>{
    const g=active();for(let n=0;n<3;n++){g.guards.forEach(d=>d.hp=0);g.update(.01,input());if(n<2){g.nextRound();g.phase='active';}}
    expect(g.over).toBe(true);expect(g.won).toBe(true);expect(g.wins).toBe(3);const score=g.score;g.update(1,input());expect(g.score).toBe(score);
  });
  it('applies saved map layouts and rejects corrupt arena records',()=>{
    const data=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v)});
    const level=newLevel('shooter',1);level.duration=45;level.rounds=1;const row=[...level.arena![12]];row[7]='3';level.arena![12]=row.join('');saveLevel(level);
    const g=createGame('shooter',false,readLevels('shooter')[0]) as ShooterGame;expect(g.map[12][7]).toBe('3');expect(g.roundDuration).toBe(45);expect(g.roundsToWin).toBe(1);expect(SHOOTER_MAP[12][7]).toBe('.');
    data.set('draw.play.levels.shooter',JSON.stringify([level,{...level,arena:['garbage']},{...level,arena:level.arena!.map(r=>r.replace('P','.'))}]));expect(readLevels('shooter')).toHaveLength(1);
  });
});
