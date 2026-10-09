# Notion Documentation Routing V1

Airodrom product documentation publishes only under the verified Airodrom project hub.

## Canonical hub

| Field | Value |
|-------|-------|
| Title | Airodrom |
| Page ID | `3f4593eead74818bb339d302719256a4` |
| URL | https://app.notion.com/p/3f4593eead74818bb339d302719256a4 |
| Parent | Workspace Projects data source |

Historical Pi Bridge hub `3ef593eead7481d79081dab81405a34f` must not parent new Airodrom milestone pages. Pi Bridge historical child documentation remains intact.

## Fail-closed publisher rules

Config: `config/notion-documentation-v1.json`  
Resolver: `src/notion-documentation-routing.js`

- Require verified Airodrom hub page ID
- Refuse missing/empty hub
- Refuse Pi Bridge (and any listed forbidden parent)
- Refuse any parent that is not the verified hub
- Documentation sync is not MERGED IN SOURCE, INSTALLED LOCALLY, LIVE VERIFIED, or PUBLIC ACTIVATION

## Status vocabulary

Use these labels explicitly:

- LOCAL IMPLEMENTATION
- PR OPEN
- MERGED IN SOURCE
- INSTALLED LOCALLY
- LIVE VERIFIED
- PUBLIC ACTIVATION OFF

## Owned pages (under Airodrom hub)

Moved (IDs preserved):

- Meta WhatsApp Live Connection V1 — `3f4593eead7481bda472e3a94dc1a60f`
- Development Sessions V1 — `3f4593eead74817f8d8ecb8d448dc88c`
- Control Center UI Recovery V1 — `3f4593eead7481018b16f930c8ce71ce`

Created under hub (no prior Airodrom-owned page):

- Automatic Acceptance V1 — `3f4593eead7481c6a2c0c6afe7779718`
- Live Observatory V1 — `3f4593eead748141a767ca2ef6b8e402`
- Menu Bar V2 — `3f4593eead74811fba37d40378388d11`

Pages were not duplicated under Pi Bridge. Historical Pi Bridge material remains intact.
