# Driftfield

Fly a ship through an endless asteroid field. Scoop red ore, dodge (and shoot down)
raiders, then fly the ore into a station ring to bank it. Grey rocks end the run;
raider bolts damage your hull (3 hits).

Browser prototype — Vite + TypeScript + Three.js, no art/assets (everything is procedural).

## Play (no terminal)

Double-click **`Driftfield.html`** in this folder. That single file is the whole game —
JavaScript, CSS and the Three.js runtime are inlined — so it runs straight from disk with
no server, no install step and no network.

`index.html` is the dev entry point; opening it from disk forwards to `Driftfield.html`
automatically, so either file works by double-click.

After changing the source, rebuild the playable file:

```bash
npm run build      # typecheck + dist/ + regenerates Driftfield.html
```

## Run (with a terminal)

```bash
npm install
npm run dev        # http://localhost:5173 (fixed port: fails rather than drifting to 5174)
npm run build      # typecheck + production build into dist/ + Driftfield.html
npm run preview    # serve the production build
npm run standalone # rebuild only Driftfield.html
```

## Troubleshooting

**Nothing happens / the Launch button is dead.** Either open `Driftfield.html` directly, or
run `npm run dev` in this folder and use the printed URL. The two cases that fail, and why:

| Symptom | Cause |
| --- | --- |
| Page shows "The game didn't start" | `index.html` was opened from disk and `Driftfield.html` is missing — run `npm run build` |
| Blank page at `localhost:5173` | No dev server running, or you are in the wrong folder |
| Launch does nothing on a working server | WebGL is unavailable; the panel names it and disables the button |
| Panel says "This browser cannot draw 3D" | WebGL 2 was refused. In Chrome: `Settings → System → Use graphics acceleration when available` → Relaunch. In Firefox: `about:config` → `webgl.disabled` = false. Chrome 157 with acceleration off also disables its software WebGL, so there is no fallback. |

If it still won't start, check the browser console (F12) and report the first red error.

## Controls

| Input | Action |
| --- | --- |
| Mouse | Pitch and yaw — pull **down** to climb, drag left/right to turn and bank (click to capture, `Esc` pauses) |
| `Space` | Fire twin cannons |
| `A` / `D` | Roll (manual trim; the ship also banks into turns on its own) |
| `W` / `S` | Raise / lower the throttle — the setting holds where you leave it |
| `Shift` | Afterburner |
| `Arrows` | Keyboard steering (down climbs, matching the mouse) |
| `M` | Toggle sound |
| `R` | Relaunch after a crash |
| Red ore | Fly through to load cargo (safe to touch) |
| Station ring | Fly inside to bank cargo for points; unbanked cargo is lost on a crash |

## Scoring & encounters

- **Distance** is survival — still the core run metric and best-score record.
- **Hull:** 3 hits. Raider bolts cost 1 hull (with brief invulnerability/feedback); grey rocks are still instantly fatal.
- **Red ore** is cargo: +1 aboard on pickup, worth **500 points** each only when banked at the station.
- **Station:** a ring with a HUD distance marker. Docking (inside the ring) banks all cargo, pulses/chimes, then the station relocates ~700 m ahead and the lane is cleared.
- **Raiders:** occasional (at most 1 at a time, with long gaps), telegraphed shots with slow dodgeable bolts and forgiving aim/hitboxes. One player hit destroys a raider (**+1000 points**).
- **Sound:** runtime Web Audio synthesis (no files). Unlocked on first user gesture; `M` mutes. No engine drone.

## How it is built

| File | Role |
| --- | --- |
| `src/main.ts` | Renderer, lights, fixed-step loop, run state, input wiring, encounter/scoring integration |
| `src/ship.ts` | Flight model, ship mesh, 3-sphere collision proxy, `SHIP` tuning block |
| `src/asteroid-field.ts` | Procedural rock/ore shapes, instanced rendering, streaming, swept collision, clear zones |
| `src/station.ts` | Docking ring mesh/placement/animation and docking volume |
| `src/enemies.ts` | Raider AI, telegraphed shots, player/enemy bolts, explosions |
| `src/chase-camera.ts` | Spring-follow camera, banking, speed FOV, shake |
| `src/starfield.ts` | Distant stars + velocity-aligned dust streaks (the speed cue) |
| `src/hud.ts` | DOM overlay: readouts, threat/station marker, popups, title/death panels |
| `src/audio.ts` | Synthesised SFX, lazy gesture unlock, mute |
| `src/scoring.ts` | Point constants and formatting |
| `src/noise.ts` | PRNG + 3D value noise used to deform rocks |
| `scripts/build-standalone.mjs` | Inlines the built JS/CSS into `Driftfield.html` so it runs from `file://` |
| `vite.standalone.config.ts` | Single-chunk build (no code splitting, no external assets) feeding that script |

Things worth knowing before you touch it:

1. **Physics runs on a fixed 1/120 s step**, decoupled from rendering. Collision uses the segment between the ship's previous and current collider positions, so a boosted ship cannot tunnel through a thin rock.
2. **The field streams in a ball around the ship.** Rocks beyond the radius are recycled to the fog horizon in the forward hemisphere. The start scatter and station each carve/maintain a clear lane (`clearSphere`) so approaches stay readable.
3. **Rocks are `InstancedMesh`** — 8 base shapes for grey rocks plus 8 target-core and 8 halo meshes for red ore (24 draw calls total). Rock shape is noise applied to a vertex's *direction*, not its index.
4. **Red ore, raiders, and docking are separate concerns layered on the field.** Ore is cargo until docked; raiders/bolts use their own entities and swept checks against the ship/raiders.

## Tuning

Density, speed and encounter pressure are the whole game:

- `src/ship.ts` → `SHIP`: cruise/throttle/boost speeds, `throttleRate`, rotation/bank response, collider size.
- `src/asteroid-field.ts` → `FIELD_RADIUS`, `RECYCLE_RADIUS`, `MIN_SPAWN_DISTANCE`, `START_CORRIDOR_*`, and rock/ore counts passed to `new AsteroidField(seed, rocks, ore)` in `main.ts` (currently 78/7).
- `src/station.ts` → ring/clear/dock radii and placement distances.
- `src/enemies.ts` → raider counts/timing/ranges, hit radius, bolt speeds.
- `src/scoring.ts` → point values.
- `src/main.ts` → fog density, hull/invulnerability, station relocate distance, encounter wiring.

Useful measured baseline (headless Chrome, 1280×760): at 155 rocks idle survival was **~12.0 s mean** (5-run manual sim). Density is now halved to 78 rocks / 7 ore for more room (re-tune by feel on a real GPU).

## Dev hooks

In dev builds only, `window.__driftfield` exposes `{ ship, field, chase, steer, station, raiders, audio, getState() }`. `getState()` returns `{ state, paused, distance, best, cargo, oreCollected, points, kills, hull, raidersAlive, stationDistance }`. It exists so QA tooling can read/manipulate real state instead of guessing from screenshots.
