@AGENTS.md

# CLAUDE.md — SuperCoolRadio website repo

This is the production website for SuperCoolRadio (SCR): Next.js + Leaflet, deployed to Cloudflare Workers by Cloudflare Workers Builds through the OpenNext adapter. This file holds only invariants. It changes only on Hugh's explicit instruction.

## Where the project lives

The project's documentation home is the **scr-core** repo (github.com/SuperCoolRadio/scr-core): the Concept, the registry, and the journal. Design questions are answered there, not here. Record your sessions in scr-core's journal, per its own CLAUDE.md.

## Authority to work here

Claude Code works in this repo only under a written ruling from Hugh, committed at this repo's root, and only on the items that ruling names. Without a current ruling covering the task, this repo is read-only.

## Branches and pull requests — hard rules

- `main` is production: every merge to it deploys to the live public site. A GitHub ruleset forbids direct pushes to `main`. Never attempt to bypass it.
- All work happens on feature branches. Never commit to, push to, or merge `main`.
- Each change arrives as a pull request. Cloudflare builds the branch as a private preview; report the PR and the preview URL to Hugh. Hugh reviews the preview in his browser and merges by hand. You never merge.
- Cloudflare settings (build commands, bindings, domains) are changed by Hugh in the Cloudflare dashboard, never by you. If they need to change, report the proposed settings to Hugh.

## Credentials

- This clone uses its own GitHub token, scoped to this repo only (Contents and Pull requests). It cannot touch scr-core, and scr-core's tokens cannot touch this repo. Keep it that way: never ask for or use broader credentials.
- The token is held by a git credential helper configured in this clone, never in the remote URL. Never print it, log it, or put it in a URL, a file in the repo, or a commit.
