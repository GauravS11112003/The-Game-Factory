# Draw-a-Level: Project Context

An open-source game space where anyone creates a playable game by drawing on paper or a canvas. Rules come from handwritten notes on the drawing or from a text prompt. Anyone can extend someone else's game by drawing on it again: adding levels, objects and mechanics.

Target: a hackathon build.

## Thesis (pitch framing)

- Weak framing: "games get boring after a few days."
- Strong framing: Minecraft, Roblox and Geometry Dash last because **players make the content**. Geometry Dash went about 7 years between 2.1 and 2.2 and stayed popular. Making content is hard (Roblox needs Lua, Mario Maker needs a Switch, the GD editor takes hours). **Paper removes the skill barrier**: anyone who can draw can create, and anyone can extend someone else's game.

## Prior art (judges may know it)

- Pixel Press Floors
- Draw Your Game app

Both turned paper drawings into platformer levels, so "photo becomes a playable level" alone is not new.

## What is new (lead with these)

1. **Handwritten rules become mechanics.** "This platform moves", an arrow showing a path, or "door opens when you get the key", written on the page, actually work in the game.
2. **Paper-native remixing.** Print a level, draw onto it, scan it, and it becomes a child level that credits the original.
3. **Drawn sprites.** The doodled character is the player.

## Hackathon verdict

- Creativity: good on its own, strong with the three twists above.
- Winning potential: high. Judges take part in the demo, the idea is understood in five seconds, it needs no hardware, and it covers education and accessibility.
- Risks: demo-day lighting and scope creep. The idea itself is not the risk.

## Architecture

**Core decision: everything compiles to one level JSON format.** Paper, canvas and text prompt are only different ways of producing it. The engine only plays JSON. A remix is a new JSON with a `parent` pointer. This is what makes "open source" meaningful, because anyone can build a new engine or editor against the format.

```json
{
  "id": "lvl_8f2a", "parent": "lvl_31c0", "author": "maya",
  "grid": { "cell": 16, "w": 120, "h": 68, "tiles": "<run-length encoded>" },
  "entities": [
    { "type": "player_start", "x": 3, "y": 50, "sprite": "spr_maya_cat.png" },
    { "type": "platform", "x": 40, "y": 30, "w": 8,
      "behavior": { "move": { "path": [[40,30],[60,30]], "speed": 2 } } }
  ],
  "rules": [{ "when": "collect:key", "then": "open:door_1" }]
}
```

### Pipeline

1. **Capture with a printed template.** No random paper in the demo. The sheet has:
   - 4 ArUco corner markers (perspective fix)
   - color reference swatches (calibrate for any lighting)
   - a legend
   - a "draw your character here" box
   - a QR code with the level ID

   This removes most of the computer vision flakiness.
2. **Shapes with classical CV (OpenCV).** Warp the photo to the template, segment colors in HSV using the swatches, then turn the ink into a tile grid: a cell is solid if ink covers about 30% of it.
   - Color code: **black** = ground, **red** = hazards, **green** = goal, **blue** = collectibles.
   - Why a grid beats polygon colliders: physics stays stable, hand-drawn slopes become charming staircases, and merging remixes is trivial.
3. **Rules with a vision LLM.** Send the photo to a vision model to read handwritten notes and arrows. It returns structured JSON chosen **only from a fixed behavior library**: patrol, moving platform, bounce pad, gravity flip, key and door, checkpoint, timer.
   - Never let the model write code. A fixed vocabulary keeps levels safe, predictable and remixable.
   - If the AI call fails, the CV-only level still plays.
   - The text-prompt input uses the same output format.
4. **Engine.** Phaser 3 with arcade physics, a tilemap built from the grid, and one component per behavior. Crop the character box, remove the white background, and use it as the player sprite. **This is the wow moment.**
5. **Solvability check.** Before publishing, search the grid using the player's jump arc to confirm the goal is reachable. If it isn't, highlight the problem ("this gap is too wide"). Kids' levels are often impossible, and this polish is what separates a toy from a platform.
6. **Remix.**
   - A "Remix on paper" button prints the level in light gray with the same markers and QR code.
   - People draw additions in color and scan. The QR code identifies the parent, the threshold ignores the gray, and only the new ink becomes the child level.
   - To add a level, draw on a blank sheet and append it to the game.
   - Store levels in Postgres with `parent_id` and show a remix tree with credits.
   - Later: mirror levels into a GitHub repo so remixes are literally forks.

### Moderation

If kids are the audience, judges will ask. Run uploads and text through the vision model for an appropriateness check before publishing. It takes one slide and very little code.

### Stack

- Frontend/engine: Vite + TypeScript + Phaser 3, as a mobile web app
- Vision service: Python FastAPI + OpenCV (easier to debug than OpenCV.js)
- Rules: a vision LLM with structured output
- Data and images: Supabase

## Hackathon scope

**Build for real:**
- template → CV → play
- 4–5 AI-interpreted behaviors
- the drawn sprite
- paper remix of one level
- the solvability check

**Fake or seed:** accounts, feed, likes, and a remix tree with pre-made data.

**Team of 4 split:**
1. CV
2. Engine
3. AI + schema
4. Backend + UI

**Lock the JSON schema in the first hour** so everyone can work in parallel.

## Demo script (~3 min)

1. Play a level the team drew (20 s).
2. Hand a judge a remix sheet and markers. They add spikes and a coin, then write "this platform moves" with an arrow.
3. Scan it and play their remix about 10 s later, with their doodle as the character.
4. Show the remix tree: their level now sits under yours with their name on it.

**Bring:** thick markers (no yellow, it vanishes on white paper), a clip lamp, a pre-tested phone, and backup photos already scanned in case the room lighting fails.

## Open next step

Draft the full level JSON schema and behavior library. It's the piece the whole team builds against.

_Note: the earlier chat included an architecture diagram that didn't come through in the paste. The Pipeline section above describes the same system._
