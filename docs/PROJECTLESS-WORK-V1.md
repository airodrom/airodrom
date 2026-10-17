# Projectless work

Ordinary conversation, operator settings, and development requests do not require a registered Project.

When a request does not name an authorized repository, Airodrom prepares a new private task sandbox. That directory is not a checkout of an enrolled project and grants no access to other files.

An enrolled repository is used only when the request names that Project or its authorized path. An unrecognized path is refused. Existing Projects remain available for organization and for work that names them.

An operator request that names a projectless task sandbox and an exact `fixture.txt` change dispatches OpenCode in that sandbox. The host verifier checks the file bytes. Automatic Acceptance runs only after that verification passes and the existing OpenCode risk policy allows it. No Project or user Goal is registered. Cursor remains selectable only when qualified; live Cursor dispatch stays blocked while subscription spend is `UNKNOWN_SUBSCRIPTION`.

Host verification, worker qualification, sandbox isolation, and high-impact fail-closed controls are unchanged.
