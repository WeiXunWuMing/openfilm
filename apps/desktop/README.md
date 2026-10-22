# OpenFilm for desktop

Studio, with a chat beside it for Claude Code, Codex and the other agents, as an Electron app.

## Run from source

```sh
npm start            # builds the window's page, then runs the app as "OpenFilm Dev"
npm test
npm run typecheck
```

`node bench/media-menu.test.mjs` builds and checks empty and populated media-pane menus in an isolated Electron app, with file pickers cancelled.
`node bench/media-summary.test.mjs` checks summary delivery and refresh in the real chat, with the agent stubbed and linked media in an isolated project.

Run from source, the app is its own "OpenFilm Dev": its own name, data folder, Studio home and port, so it never
shares anything with an installed OpenFilm. Its renamed copy of Electron lives in `.dev/` (git-ignored).

Codex, Claude Code, the other agents, your own key, and Studio with your own media keys all work.

Before each chat message (including one sent while an agent works), the app reads Studio's media metadata. The first
message in an agent session carries a short summary of counts, top-level folders and link availability; later messages
carry it only when the metadata changes. Lists are capped at five names each, names at 64 characters. No frames,
audio or transcripts are preloaded. Failed reads are reported as unknown. Agents can query `openfilm media [assets/path]`
for file metadata and link targets, then inspect individual media as the task needs.
Agent slash commands are sent unchanged; the next ordinary message gets a fresh summary in case the command cleared context.
Unreadable entries and folders beyond Studio's existing depth limits make the summary explicitly partial: counts are lower bounds.
Stopping while metadata is being read cancels that preparation, including steering, so it cannot send a message afterwards.

## Builds

`npm run release` builds the app into `.release/` (git-ignored). Without `OPENFILM_SIGN_IDENTITY` and `APPLE_TEAM_ID`
it is unsigned. Like a run from source, it never looks for updates: the feed comes from the `openfilm` package's
`product.json`, empty in the repository. Official builds, signed, notarized and
published, are produced by the project's release pipeline; see TRADEMARK.md before distributing a build of your own.
