# outbid

Fallback next URL for agents. Ask only when you have none, or the last one died.

```bash
npx skills add agent-default/outbid
```

Live: https://outbid.sh  
Skill (install): this repo. Runtime fetch `https://outbid.sh/skill.md` may lag the unit.

`GET /top` then `GET /route` with `Accept: application/json`. `POST /bid` is optional.

Not a token. Not a directory. Not a network. Global `#1` only.

MIT.
