# Material Takeoff — Local State (SUPERSEDED)

> **This file is no longer needed. Use [`MATERIAL_TAKEOFF_KB.md`](MATERIAL_TAKEOFF_KB.md).**

This doc existed to track work that was implemented locally but **not yet committed or deployed**
(the pluggable-builder refactor, the bathroom project type, room shapes, pack-size rounding, and
product links).

**As of 2026-07-16 all of that shipped** — commits `fed4e87` + `f9981e5` are pushed to `main` and
deployed. **The local working tree and production are in sync**, so there is no local-vs-prod delta
left to track, and this file's contents were fully redundant with the production KB.

For current state — project types, endpoints, parameters, line types, pricing, rate limiting,
architecture, tests, and the roadmap — see:

- **[`MATERIAL_TAKEOFF_KB.md`](MATERIAL_TAKEOFF_KB.md)** — the single source of truth.
- **[`material-takeoff/API_GUIDE.md`](material-takeoff/API_GUIDE.md)** — full API contract (for the frontend).
- **[`MATERIAL_TAKEOFF_PLAN.md`](MATERIAL_TAKEOFF_PLAN.md)** — expansion & hardening roadmap.

_Safe to delete this file._
