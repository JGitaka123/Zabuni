# Production deployment order

Deployments use an expand, deploy, contract sequence. Database changes must be
safe for both the currently running application and the application being
released. A migration may add a new function signature, column, or table, but
must not remove the old contract in the same release that starts using the new
one.

## Sequence

1. Apply forward-only migrations and verify the migration ledger checksums.
2. Run readiness and a smoke check against the new database contract while the
   current application version is still serving traffic.
3. Deploy the API and web application gradually.
4. Verify authentication, tenant context, and the current catalog workflows.
5. Keep compatibility overloads and columns until rollback to the previous
   application version is no longer possible.
6. Remove obsolete contracts only in a later, separately reviewed migration.

## Tenant-owner provisioning compatibility

Migration `0019_owner_display_name.sql` introduced a seven-argument
`app.provision_tenant_owner` function so email-authenticated owners can supply a
display name. Migration `0020_owner_provisioning_compatibility.sql` restores the
previous six-argument signature as a narrow invoker-rights wrapper. It remains
available through the rollback window and delegates to the audited seven-
argument implementation with a null display name, preserving the documented
identity-name and email-local-part fallback.

Do not remove the six-argument overload until every environment has run a
release that calls the seven-argument function and rollback to an older API
build is no longer supported.
