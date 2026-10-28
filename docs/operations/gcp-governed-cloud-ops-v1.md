# GCP Governed Cloud Operations V1

Host-routed, exact-scope Google Cloud Storage Terraform state-backend CREATE for Somin.

## Status

- MCP capability `gcp_gcs_tf_state_backend_create`: **inactive** (`active: false`), standing decision `approval_required`.
- Legacy `cloud_*` MCP stubs remain inactive.
- Host rail: `/gcp …` via `gcp-intent` → `gcp-gcs-tf-state-service`.
- Live CREATE requires: authenticated Terminal session, project enrollment, injected GCP credential provider, exact-scope preview, and `/gcp confirm <preview-id>`.
- Enrollment alone is **not** write authority.
- Chat / ChatGPT / NL “yes” never authorizes CREATE.

## Exact V1 scope (Somin only)

| Field | Value |
| --- | --- |
| Project | `somin-ca-prod` / `172228664875` |
| Bucket | `gs://somin-ca-prod-tf-state` |
| Location | `northamerica-northeast1` |
| Storage class | `STANDARD` |
| UBLA | enabled |
| Public access prevention | `enforced` |
| Versioning | enabled |
| Encryption | Google-managed |
| Writer | `user:andcantech@gmail.com` → `roles/storage.objectAdmin` (bucket-scoped) |
| Prefix (documented) | `terraform/prod` |
| Arecibo reuse | forbidden |

Any parameter drift fails closed (`gcp_exact_scope_mismatch`). Existing buckets that mismatch posture fail closed. Matching existing buckets are refused (no silent reuse or repair).

## Owner procedure

1. Install/review this release (do not activate MCP cloud mutation categorically).
2. Ensure a host GCP token provider is wired (`server.gcpTokenProvider`) for the authenticated founder identity. Credentials must never enter prompts, Mission packets, or PR evidence.
3. Enroll the project (explicit, revocable, auditable):

   ```text
   /gcp enroll project somin-ca-prod 172228664875
   ```

4. Stage CREATE:

   ```text
   /gcp tf-state preview somin
   ```

5. Review the exact resource and security settings in the preview.
6. Confirm once:

   ```text
   /gcp confirm <preview-id>
   ```

7. On uncertain/partial outcomes: inspect provider metadata/IAM; **no** automatic retry or delete.

Revoke enrollment:

```text
/gcp unenroll project somin-ca-prod
```

## Security properties

- No unrestricted `gcloud` / shell / argv execution.
- Structured Storage JSON API only (`storage.googleapis.com`).
- Independent checks of project enrollment, identity, exact scope, approval expiry, exclusive lease, idempotency, and post-create posture/IAM.
- Secrets redacted from transport error surfaces.
- Durable ops table provides anti-replay after completion.

## Rollback

1. Do not merge/install if review fails.
2. If installed but unused: `/gcp unenroll project somin-ca-prod` and leave MCP `active: false`.
3. If a bucket was created under approval: retain journal; deletion requires a **separate** empty-bucket proof and owner approval (not part of V1).
4. Policy proposal to keep categorical cloud mutation inactive: `gcp-governed-cloud-ops-v1-policy-proposal.md`.

## Somin bootstrap interface

Somin V1.1 `scripts/somin_backend_bootstrap.py` remains dry-run by default and raises `UnavailableHost` for live CREATE. Operators submit the immutable request digest to Airodrom’s `/gcp tf-state preview somin` rail rather than calling cloud APIs from the Somin checkout.

## Known limitations

- V1 supports only the locked Somin SPEC.
- Credential provider must be host-injected; no ambient ADC auto-discovery in the adapter.
- MCP broker path remains denied until a separate owner-approved activation.
- No Terraform init/apply/import, no destination IAM grant, no billing changes, no Arecibo changes.
