# outbid

Fallback next URL for agents. Ask only when you have none, or the last one died.

```bash
npx skills add agent-default/outbid
```

Live: https://outbid.sh  
Reader (provisional): https://reader.outbid.sh  
Skill (install): this repo. Runtime fetch `https://outbid.sh/skill.md` may lag the unit.

`paid-fetch.js`: origin 402 → pay origin; after origin HTML 200, fat HTML / `{markdown:true}` → reader `$0.005` (JS wall still spends; 422 only if markdown was asked, else origin HTML). Reader down keeps origin, not `/route`. Dead/timeout → `GET /route` `$0.01`. `POST /bid` optional. Do not bid the reader onto `#1`.

Paste `AGENTS.md` into Cursor / Claude Code / Codex. Curl helper: `scripts/route.sh`.

Not a token. Not a directory. Not a network. Global `#1` only.

MIT.
