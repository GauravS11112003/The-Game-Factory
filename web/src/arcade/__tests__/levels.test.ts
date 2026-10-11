import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGame, FighterGame, MazeGame, PlatformGame, RacingGame, MAZE } from '../games.ts';
import { newLevel, readLevels, saveLevel } from '../levels.ts';
const input = () => ({down:new Set<string>(),pressed:new Set<string>()});
afterEach(() => vi.unstubAllGlobals());
describe('playable custom arcade levels', () => {
  it.each(['pacman','neon'] as const)('uses custom %s walls and pellets without changing the original',id=>{
    const level=newLevel(id,1);const row=[...level.maze![3]];row[3]='#';row[4]='o';level.maze![3]=row.join('');
    const game=createGame(id,false,level) as MazeGame;
    expect(game.wall(3,3)).toBe(true);expect(game.pellets.has('3,3')).toBe(false);expect(game.pellets.get('4,3')).toBe(true);expect(MAZE[3][3]).toBe('.');
  });
  it('plays the edited platform layout and finishes at its new flag',()=>{
    const level=newLevel('platformer',1);level.platforms=[{x:0,y:450,w:900,h:160}];level.coins=[];level.enemies=[];level.finish=600;
    const game=createGame('platformer',false,level) as PlatformGame;
    game.x=590;game.update(1/120,input());expect(game.won).toBe(true);expect(game.platforms).toHaveLength(1);
    game.platforms[0].w=100;expect(level.platforms[0].w).toBe(900);
  });
  it('uses the edited hills for car physics, pickups, and finish distance',()=>{
    const level=newLevel('racing',1);level.hills=[{x:0,y:320},{x:800,y:400}];level.pickups=[{x:300,fuel:true}];level.finish=500;
    const game=createGame('racing',false,level) as RacingGame;
    expect(game.ground(400)).toBe(360);expect(game.y).toBe(296);expect(game.pickups).toEqual([{x:300,fuel:true,taken:false}]);
    game.x=501;game.update(1/120,input());expect(game.won).toBe(true);
  });
  it('applies fighter starts, round timer, and match rules to play and round resets',()=>{
    const level=newLevel('fighter',1);level.spawns=[120,850];level.duration=30;level.rounds=1;
    const game=createGame('fighter',false,level) as FighterGame;
    expect(game.players.map(p=>p.x)).toEqual([120,850]);expect(game.timer).toBe(30);
    game.players[1].hp=0;game.update(1/120,input());expect(game.won).toBe(true);
    level.rounds=3;const longer=createGame('fighter',false,level) as FighterGame;
    longer.roundPause=.001;longer.timer=1;longer.update(.01,input());expect(longer.timer).toBe(30);expect(longer.players.map(p=>p.x)).toEqual([120,850]);
  });
  it('keeps levels ordered, updates edits, and ignores corrupt saved levels',()=>{
    const data=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v)});
    const a=newLevel('fighter',1),b=newLevel('fighter',2);saveLevel(a);saveLevel(b);a.duration=45;saveLevel(a);
    expect(readLevels('fighter').map(l=>l.id)).toEqual([a.id,b.id]);expect(readLevels('fighter')[0].duration).toBe(45);
    data.set('draw.play.levels.fighter',JSON.stringify([a,{...b,spawns:['bad',850]}]));expect(readLevels('fighter')).toHaveLength(1);
  });
});
