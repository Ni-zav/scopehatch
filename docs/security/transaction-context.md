# Transaction identity boundary

Status: candidate mitigation. Independent security review is required before merge or release.

## Trust and residual risk

Migration 008 replaces writable tenant and actor settings with HMAC-authenticated identity claims.
The application signs claims only after trusted OIDC validation and membership selection.
Membership discovery uses a separate claim purpose and grants no tenant row access.
Each claim binds the full transaction ID, backend PID, database, session login, and PostgreSQL server start time.
Legacy tenant and actor settings grant no authority.

The runtime login cannot read the database key or execute the administrator signing helper.
Functions use fixed search paths. The crypto function uses the installed extension namespace.
The API checks runtime privileges and key agreement before it opens a listener.
It rejects direct or inherited ownership of tables in both protected schemas.
All protected tables must enable RLS and apply it to the effective runtime role.
All protected tables require FORCE RLS except `memberships`, whose owner supports the trusted membership functions.
The runtime login must not inherit that owner or receive write privileges on membership or issuer tables.
These checks detect startup configuration drift. Administrators must not change privileges while application sessions remain active.
Keep parameterized queries. Arbitrary SQL can still damage the authorized scope or cause denial of service.
Application-process compromise, key theft, and database-administrator compromise remain outside this SQL-only boundary.
Database metadata and activity views are not confidential tenant storage. Do not store private text in identifiers.
This mitigation does not establish production readiness or independent security acceptance.

## Generate and protect the key

Use a dedicated Linux host identity or secret manager. Windows file permissions do not provide this POSIX permission check.

1. Set `umask 077` in the protected operator shell.
2. Generate the key with `openssl rand -hex 32 > /protected/context_key`.
3. Set the owner to the application UID, or root when the reader runs as root.
4. Set file mode `0400` or `0600`.
5. Set `SCOPEHATCH_CONTEXT_KEY_FILE` to that regular file.
6. Mount the same key into the migration and application processes.

For Compose, use `deploy/secrets/context_key`, owner `1000:1000`, and mode `0400`.
Generate separate administrator, runtime-password, cursor-signing, and context-signing secrets.
Never print secrets or put them in Git, images, command arguments, or review artifacts.
The context file contains exactly 64 lowercase hexadecimal characters, with an optional final newline.
Symlinks, group access, other-user access, invalid owners, and malformed contents are rejected.
Keep the parent directory protected against replacement.

## Install or upgrade

1. Obtain independent approval for the candidate and a maintenance window.
2. Preserve an encrypted backup and the matching application image.
3. Stop all application writers and drain database sessions.
4. Install the protected context file for the migration and application identities.
5. Run `npm run db:migrate --workspace @scopehatch/persistence` with protected administrator configuration.
6. Start the candidate application with the restricted runtime login.
7. Verify signed authentication, membership, tenant isolation, independent approval, and held inference usage.

The runner applies migrations 001–008 to an unprotected database.
On a protected database, it skips migrations 001–007 and reapplies 008 idempotently.
This prevents restart from temporarily restoring legacy helpers.
An existing key mismatch fails migration. It never silently rotates the installed key.
Do not execute old migration files manually against an online protected database.
Do not roll back only the image: older applications cannot provide authenticated transaction context.
Use a reviewed forward fix, or restore the matching pre-upgrade database and image into an isolated target.

## Rotate after planned maintenance or suspected compromise

Rotation requires downtime. There is no dual-key grace period.

1. Stop all application and migration processes.
2. Terminate their database sessions through a protected administrator connection.
3. Generate a new protected context file.
4. Read the file through an administrator client and pass its decoded bytes as a SQL parameter.
5. Execute `UPDATE scopehatch_private.context_key SET key=$1 WHERE singleton` within an administrator transaction.
6. Require exactly one updated row before commit.
7. Replace the mounted key on every application and migration instance.
8. Start one candidate instance and verify startup key agreement.
9. Run the tenant, authentication, approval, replay, and inference-hold checks before restoring access.

Do not place key literals in SQL files, shell history, or SQL logs.
If replacement fails, keep applications stopped. Restore consistent DB and file keys through protected administration.
For suspected theft, rotate runtime and administrator credentials as required by the incident investigation.

## Backup and isolated recovery

A full database dump includes `scopehatch_private.context_key` and is signing authority.
Encrypt the dump before off-host transfer. Protect its encryption keys independently.
Back up the protected context file with access controls equivalent to the dump.
Record the application SHA, PostgreSQL version, and migration level without recording secret values.

1. Restore into an isolated empty database with compatible PostgreSQL and protected administrator credentials.
2. Restore cluster roles separately; logical dumps do not contain them.
3. Keep the private key table and its ACLs in the restore.
4. Supply the matching protected context file, or perform the explicit rotation procedure while isolated.
5. Run the migration runner with the matching key.
6. Verify restricted startup, tenant isolation, immutable approvals, audit, idempotency, and held usage.
7. Verify signed OIDC and distinct-human approval before an authorized cutover.

Do not install a different random key implicitly after restore.
The restored server start time invalidates old transaction claims, even if database transaction identifiers repeat.
The disposable recovery script checks database invariants. It does not verify encrypted off-host recovery or real identity.
