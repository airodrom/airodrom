# Policy proposal — GCP governed cloud ops V1 (owner review only)

This document is **not** an activation. It proposes retaining fail-closed MCP cloud mutation while documenting the host rail for exact-scope Somin GCS tf-state CREATE.

## Current standing policy

| Capability | Risk | Standing decision | Active |
| --- | --- | --- | --- |
| `cloud_*` (inventory → destroy) | various | mostly `approval_required` / inactive | `false` |
| `gcp_gcs_tf_state_backend_create` | PRIVILEGED | `approval_required` | `false` |

## Proposal (do not auto-apply)

1. Keep `gcp_gcs_tf_state_backend_create.active = false` for MCP/broker.
2. Keep host `/gcp` rail as the only CREATE path after enrollment + preview confirm.
3. Do **not** flip categorical `cloud_iam_mutate` / `cloud_infra_destroy` / unrestricted GCP execution to automatic or broadly active.
4. Any future MCP activation requires a separate authenticated owner approval naming the exact capability and scope digest.

## Owner review string (optional, separate from bucket CREATE)

> I acknowledge the Airodrom GCP Governed Cloud Ops V1 host rail for exact-scope `gs://somin-ca-prod-tf-state` CREATE. I do **not** authorize activating MCP `cloud_*` mutation capabilities or unrestricted gcloud execution. Project enrollment and per-operation `/gcp confirm` remain mandatory.

## Rollback

Leave policy JSON unchanged from this PR’s inactive defaults; unenroll projects; do not install if review rejects the host rail.
