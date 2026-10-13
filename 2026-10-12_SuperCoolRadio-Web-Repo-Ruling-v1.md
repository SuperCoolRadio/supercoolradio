# 2026-10-12 SuperCoolRadio Web Repo Ruling (v1)

## Summary

This ruling, issued by Hugh through the chat side, authorizes
Claude Code to work on the production website repository for
four named items, under branch-and-pull-request rules, and for
nothing else. For this work only, it supersedes the scr-core
CLAUDE.md rule placing the website repo out of scope. The
website repo remains out of scope for all future sessions
unless a later ruling says otherwise.

## Definitions

- **Web repo**: github.com/SuperCoolRadio/supercoolradio,
  cloned on mini at `~/supercoolradio`. This clone carries its
  own GitHub token, scoped to this repo only (Contents and
  Pull requests, read/write). The scr-core tokens cannot touch
  this repo, and this token cannot touch scr-core.
- **main**: the production branch. When the build pipeline is
  healthy, Cloudflare Workers Builds deploys main to the live
  public site. A GitHub ruleset (protect-main, active) forbids
  direct pushes to main; changes arrive only by pull request,
  merged by Hugh in the browser. Do not attempt to bypass this.
- **Preview**: a Cloudflare build of a non-main branch,
  reachable at a private URL. Non-production branch builds are
  enabled for this project.

## Known state (verified 2026-10-12, chat side)

1. The last Cloudflare build ran May 2026 and failed at
   `npm clean-install`: the repo pins `next@16.2.4`, but
   `@opennextjs/cloudflare@^1.19.11` requires
   `next >=15.5.18 <16 || >=16.2.6`. No build has run since;
   the live site serves an old deployment.
2. That failed build was triggered by Cloudflare's own bot
   branch `cloudflare/workers-autoconfig` (migration to
   Workers Builds), still unmerged on GitHub. No human change
   is known to be pending on main.
3. Cloudflare's currently saved commands are
   build `npm run build`, deploy `npx wrangler deploy`,
   version `npx wrangler versions upload`. These differ from
   the commands the May build used
   (`npx opennextjs-cloudflare build` / `upload`), were
   changed after that failure (likely by the migration), and
   have never been exercised. They may not match package.json.

## Authorized work (exactly these)

1. **Build fix.** Resolve the Next.js / OpenNext peer
   conflict (bump Next to a version the adapter accepts;
   regenerate the lockfile). Verify Cloudflare's saved
   commands against package.json and the OpenNext setup; if
   they are wrong, report the mismatch and the proposed
   correct commands to Hugh — Cloudflare settings are changed
   by Hugh in the browser, not by you.
2. **Bot branch review.** Read `cloudflare/workers-autoconfig`.
   If its config is needed, incorporate it into your feature
   branch; if not, report why. Either way Hugh decides whether
   to delete the bot branch afterward.
3. **Basemap toggle.** Add a Leaflet layers control switching
   between the existing NASA Blue Marble tiles and standard
   OpenStreetMap, with proper attribution for both and zoom
   limits appropriate to each source. This amends the locked
   map interaction model by adding an alternative basemap; the
   NASA layer itself stays untouched and remains the default.
4. **maxNativeZoom fix.** Change the NASA layer's
   maxNativeZoom from 8 to 9 (with zoomOffset −1), so the
   deepest tile level actually loads. Verified visually on a
   preview at maximum zoom.

## Rules of engagement

- All work happens on feature branches. Never commit to,
  push to, or merge main.
- Sequencing: item 1 first, as its own pull request, and its
  branch build must come back green on Cloudflare before work
  on items 3 and 4 begins. Items 3 and 4 may share a second
  pull request. Item 2 folds into whichever PR it belongs in.
- Deliverable per pull request: the PR itself plus the
  preview URL, reported to Hugh. Hugh reviews the preview in
  his browser and merges by hand. You never merge.
- Additionally: draft a minimal CLAUDE.md for this repo
  (invariants only — the branch/PR rules above, the scoped
  token, pointer to scr-core as the project's documentation
  home) and include it in the first PR. Hugh will relay the
  draft to the chat side for review before that PR merges.
- At session end, record this work as a normal journal entry
  in scr-core's BUILD-LOG.md per the standing ritual, noting
  this ruling by filename.
