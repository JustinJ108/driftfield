# Driftfield — working context

## Goal
Browser game (Three.js + Vite): fly an endless asteroid field. Distance is survival;
red ore is cargo banked at a station for points. Raiders can shoot you; you can
shoot back. Hull damage and rock collisions end the run.

## Decisions and why
- **Arcade runner flight, fixed 1/120 s step, swept 3-sphere collision, streaming
  instanced field** — deterministic, fair-feeling motion without a physics engine.
- **Flight-stick pitch & yaw-coupled bank** (mouse down climbs; turns lean ~50° max
  and self-level). `A`/`D` manual roll; `W`/`S` held throttle setting, boost overrides.
- **Red ore is cargo, not instant score.** Safe pickup (+1 aboard); docking in the
  station banks 500/ore. Unbanked cargo lost on death. Distance remains primary best.
- **Station as a moving objective.** Ring (24 m dock) with HUD marker/distance; on
  bank it pulses, relocates ~700 m ahead, and a 46 m clear sphere is maintained.
- **Hull + occasional, forgiving raiders.** Hull 3: enemy bolts cost 1 hit with brief
  invuln/feedback; grey rocks still instantly fatal. Raiders are occasional (max 1,
  long grace/gaps), telegraphed slow bolts, 1 player hit kill, +1000, easy to hit/avoid.
  `Space` fires cannons. Firing/Space keyup must not restart the run (blur + preventDefault).
- **Runtime Web Audio synth, no assets.** Lazy gesture unlock; `M` mutes; exception-safe.
- **Thinner field.** 78 rocks / 7 ore (halved from 155/14) plus start/station clear zones.
- **Single-file build (`Driftfield.html`)** with inlined JS/CSS/Three for `file://` play.

## Current state
Playable end to end: title → flight → combat/docking → crash → relaunch, with hull/
cargo/points HUD, station marker, threat warning, popups, pause on lock loss, SFX.

`npm run build` passes and regenerates `Driftfield.html`.

Measured (headless Chrome, 1280×760):
- Prior sample at 155 rocks: idle survival ~12.0 s mean (5-run manual sim). Field now 78/7.
- Tuning QA: 3 enemy bolt hits required to crash (hull 3→2→1→0 with invuln), restart
  restores hull, raider 1-shot kill, density counts correct (78 rocks/7 ore), no errors.
- Earlier round QA: ore pickup/cargo HUD, docking banks 500, station relocate, raiders,
  restart/reset, audio/mute, and `file://` standalone launch all green.

## Open questions
- Real-GPU feel: are 78/7 density, hull 3, and eased raiders the right difficulty?
- Station spacing and point balance (500 ore / 1000 raider / distance) need tuning.
- Difficulty ramp / escalation still undecided.

## Next steps
1. Play on a real GPU and tune `SHIP`, field/station/raider params by feel.
2. Polish combat/docking feedback if needed (clearer hit/telegraph cues).
3. Consider difficulty ramp with distance/time.
4. Mobile/touch not attempted.

## Log
- **2026-11-15** — Tuning/polish: asteroids halved (78/7), hull 3 vs raider bolts with
  invuln+feedback (rocks still fatal), raiders made occasional and easier (1 at a time,
  long gaps, 1-hit kill, larger/slower/less accurate), HUD hull. Fixed space-keyup
  restart/points-reset bug by blurring on run start + preventing Space keyup default.
  Headless QA green. User confirmed Chrome hardware acceleration is off.
- **2026-11-15** — Combat/cargo/audio: ore-as-cargo docked at station, raiders, Space
  cannons, Web Audio SFX + mute, density reduced 250→155, HUD/station marker/threat.
- **2026-11-15** — Feel/fairness, initial scaffold, and launch/WebGL/standalone fixes.