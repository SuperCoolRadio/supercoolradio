# 2026-10-13 SuperCoolRadio Web Repo Ruling (v2)

## Summary

This ruling authorizes Claude Code to make one change to the production website: add the OSM overlay that was tuned and locked in scr-core on 2026-10-13. Hugh gave it directly in a Claude Code session on mini, and Claude Code transcribed it here. Hugh's merge of the pull request that carries this file is his sign-off on the text. The branch-and-pull-request rules of v1 and of this repo's `CLAUDE.md` apply unchanged. After this work the repo is again read-only for Claude Code until a later ruling.

## Hugh's words (2026-10-13, verbatim)

- "Let's push this to the website."
- "Let's raize the maps's max zoom to 30. Problem solved. Eventually, we will go even higher, maybe infinitely."
- "Also, no toggle. Let's just put in the overlay from OSM. Keep everthing else about the web page the same."
- "IMPORTANT NOTE: The test page is not replacing the web page, obviously. We are just adding an overlay to the base map of the web page."
- On the site's own borders and the overlay's borders: "For now, we are keeping both."
- "The web page will change in one way only: The Blue Marble will have an OSM overlay, black and white, with the zoom levels we decided on. Not optional, always there."
- "Changed my mind. I forgot that we already had that switch there now. What I would like: Keep the switch. When activated, it does OSM, as it does righ tnow. When not activated, it does blue marble, with our overlay we came up with today."

## Items

1. **The overlay.** Draw scr-core's locked style (`src/osm_overlay/osm-overlay-style.json`, scr-core commit c4b07da) over the base map:
   - shown whenever Blue Marble is the basemap, with no control of its own; the existing basemap switch is kept, and choosing OpenStreetMap shows that map exactly as before, without the overlay;
   - in its own map pane, below the site's borders and labels, and ignoring the mouse, so hover and click behave exactly as before.

   Tiles and fonts come from OpenFreeMap's public endpoint, credited in the attribution. Renderer: `maplibre-gl` 4.7.1 with `@maplibre/maplibre-gl-leaflet` 0.0.22, pinned exactly; these are the versions Hugh tested.
2. **Max zoom 30** (was 18), for the map and both base layers. Past their native detail, the base layers draw each tile by cropping its deepest available ancestor tile, because Leaflet's built-in stretching misplaces tiles at extreme magnification. The overlay ends at zoom 25, MapLibre's limit.
3. **Nothing else changes.** That covers the borders (both the site's and the overlay's stay), hover, click-to-zoom, the breadcrumb, the basemap switch, and all Cloudflare settings. If the visitor's browser has no WebGL, the overlay is skipped and the site works as before.

## Roadmap note (not authorized here)

Eventually, a caching system on R2 for OSM data, so the site keeps what it has already fetched instead of asking the upstream for the same data over and over. Self-hosting the OSM planet on R2 (from the v1 roadmap) is related.
