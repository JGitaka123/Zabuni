import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const tenantRoles = ["owner", "manager", "sales", "finance", "readonly"] as const;
export type TenantRole = (typeof tenantRoles)[number];

export const taxClasses = ["standard_16", "zero_rated", "exempt"] as const;
export type TaxClass = (typeof taxClasses)[number];

export const usageMetrics = [
  "rfq_parsed",
  "quote_sent",
  "invoice_transmitted",
  "wa_template_sent",
  "sms_sent",
  "llm_tokens",
  "payment_processed"
] as const;
export type UsageMetric = (typeof usageMetrics)[number];

export const outboxStates = [
  "pending",
  "processing",
  "sent",
  "failed_permanent",
  "cancelled"
] as const;
export type OutboxState = (typeof outboxStates)[number];

export const incidentStatuses = ["open", "resolved"] as const;
export type IncidentStatus = (typeof incidentStatuses)[number];

const createdAt = () =>
  timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey(),
    legalName: text("legal_name").notNull(),
    tradingName: text("trading_name"),
    kraPin: text("kra_pin"),
    vatRegistered: boolean("vat_registered").notNull().default(false),
    etimsMode: text("etims_mode").$type<"oscu" | "vscu">(),
    etimsBranchId: text("etims_branch_id"),
    timezone: text("timezone").notNull().default("Africa/Nairobi"),
    currency: char("currency", { length: 3 }).notNull().default("KES"),
    plan: text("plan").notNull(),
    status: text("status").notNull(),
    createdAt: createdAt()
  },
  (table) => [
    check("tenants_legal_name_not_blank", sql`btrim(${table.legalName}) <> ''`),
    check(
      "tenants_etims_mode_check",
      sql`${table.etimsMode} IS NULL OR ${table.etimsMode} IN ('oscu', 'vscu')`
    ),
    check("tenants_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`)
  ]
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    phoneE164: text("phone_e164"),
    email: text("email"),
    name: text("name").notNull(),
    role: text("role").$type<TenantRole>().notNull(),
    createdAt: createdAt()
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "users_tenant_id_tenants_id_fk"
    }).onDelete("cascade"),
    uniqueIndex("users_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("users_tenant_phone_unique")
      .on(table.tenantId, table.phoneE164)
      .where(sql`${table.phoneE164} IS NOT NULL`),
    uniqueIndex("users_tenant_email_unique")
      .on(table.tenantId, sql`lower(${table.email})`)
      .where(sql`${table.email} IS NOT NULL`),
    check("users_name_not_blank", sql`btrim(${table.name}) <> ''`),
    check(
      "users_role_check",
      sql`${table.role} IN ('owner', 'manager', 'sales', 'finance', 'readonly')`
    ),
    check("users_contact_check", sql`${table.phoneE164} IS NOT NULL OR ${table.email} IS NOT NULL`)
  ]
);

// Better Auth identities are global so a session can be verified before a tenant
// RLS context exists. Domain users remain tenant-owned in `users` and are linked
// through `auth_memberships`.
export const authIdentities = pgTable(
  "auth_identity",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    phoneNumber: text("phone_number"),
    phoneNumberVerified: boolean("phone_number_verified").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("auth_identity_email_unique").on(sql`lower(${table.email})`),
    uniqueIndex("auth_identity_phone_unique")
      .on(table.phoneNumber)
      .where(sql`${table.phoneNumber} IS NOT NULL`)
  ]
);

export const authSessions = pgTable(
  "auth_session",
  {
    id: uuid("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    token: text("token").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id").notNull()
  },
  (table) => [
    uniqueIndex("auth_session_token_unique").on(table.token),
    index("auth_session_user_idx").on(table.userId),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authIdentities.id],
      name: "auth_session_user_id_fk"
    }).onDelete("cascade")
  ]
);

export const authAccounts = pgTable(
  "auth_account",
  {
    id: uuid("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
      mode: "date"
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
      mode: "date"
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("auth_account_provider_unique").on(table.providerId, table.accountId),
    index("auth_account_user_idx").on(table.userId),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authIdentities.id],
      name: "auth_account_user_id_fk"
    }).onDelete("cascade")
  ]
);

export const authVerifications = pgTable(
  "auth_verification",
  {
    id: uuid("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow()
  },
  (table) => [index("auth_verification_identifier_idx").on(table.identifier)]
);

export const authRateLimits = pgTable(
  "auth_rate_limit",
  {
    id: uuid("id").primaryKey(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    lastRequest: bigint("last_request", { mode: "number" }).notNull()
  },
  (table) => [uniqueIndex("auth_rate_limit_key_unique").on(table.key)]
);

export const authMemberships = pgTable(
  "auth_membership",
  {
    id: uuid("id").primaryKey(),
    identityId: uuid("identity_id").notNull(),
    tenantId: uuid("tenant_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role").$type<TenantRole>().notNull(),
    status: text("status").$type<"active" | "suspended">().notNull().default("active"),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("auth_membership_identity_unique").on(table.identityId),
    uniqueIndex("auth_membership_tenant_user_unique").on(table.tenantId, table.userId),
    foreignKey({
      columns: [table.identityId],
      foreignColumns: [authIdentities.id],
      name: "auth_membership_identity_id_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.userId],
      foreignColumns: [users.tenantId, users.id],
      name: "auth_membership_tenant_user_fk"
    }).onDelete("cascade"),
    check(
      "auth_membership_role_check",
      sql`${table.role} IN ('owner', 'manager', 'sales', 'finance', 'readonly')`
    ),
    check("auth_membership_status_check", sql`${table.status} IN ('active', 'suspended')`)
  ]
);

export const authOnboardingAudit = pgTable("auth_onboarding_audit", {
  id: uuid("id").primaryKey(),
  identityId: uuid("identity_id").notNull(),
  scopeId: uuid("scope_id").notNull(),
  membershipId: uuid("membership_id").notNull(),
  action: text("action").notNull(),
  createdAt: createdAt()
});

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    sku: text("sku").notNull(),
    description: text("description").notNull(),
    brand: text("brand"),
    packSize: text("pack_size"),
    uom: text("uom"),
    costMinor: bigint("cost_minor", { mode: "bigint" }),
    costCurrency: char("cost_currency", { length: 3 }),
    fxBufferBps: integer("fx_buffer_bps"),
    taxClass: text("tax_class").$type<TaxClass>().notNull(),
    kraItemCode: text("kra_item_code"),
    hsCode: text("hs_code"),
    leadTimeDays: integer("lead_time_days"),
    minMarginBps: integer("min_margin_bps"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt()
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "items_tenant_id_tenants_id_fk"
    }).onDelete("cascade"),
    uniqueIndex("items_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("items_tenant_sku_unique").on(table.tenantId, table.sku),
    index("items_tenant_active_idx").on(table.tenantId, table.active),
    check("items_sku_not_blank", sql`btrim(${table.sku}) <> ''`),
    check("items_description_not_blank", sql`btrim(${table.description}) <> ''`),
    check(
      "items_tax_class_check",
      sql`${table.taxClass} IN ('standard_16', 'zero_rated', 'exempt')`
    ),
    check(
      "items_cost_pair_check",
      sql`(${table.costMinor} IS NULL) = (${table.costCurrency} IS NULL)`
    ),
    check(
      "items_cost_nonnegative_check",
      sql`${table.costMinor} IS NULL OR ${table.costMinor} >= 0`
    ),
    check(
      "items_cost_currency_check",
      sql`${table.costCurrency} IS NULL OR ${table.costCurrency} ~ '^[A-Z]{3}$'`
    ),
    check(
      "items_fx_buffer_bps_check",
      sql`${table.fxBufferBps} IS NULL OR ${table.fxBufferBps} >= 0`
    ),
    check(
      "items_lead_time_days_check",
      sql`${table.leadTimeDays} IS NULL OR ${table.leadTimeDays} >= 0`
    ),
    check(
      "items_min_margin_bps_check",
      sql`${table.minMarginBps} IS NULL OR ${table.minMarginBps} BETWEEN 0 AND 10000`
    )
  ]
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    metric: text("metric").$type<UsageMetric>().notNull(),
    quantity: bigint("quantity", { mode: "bigint" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
    unitCostMinor: bigint("unit_cost_minor", { mode: "bigint" }).notNull(),
    costCurrency: char("cost_currency", { length: 3 }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt()
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "usage_events_tenant_id_tenants_id_fk"
    }).onDelete("cascade"),
    uniqueIndex("usage_events_tenant_id_id_unique").on(table.tenantId, table.id),
    index("usage_events_tenant_occurred_idx").on(table.tenantId, table.occurredAt),
    check(
      "usage_events_metric_check",
      sql`${table.metric} IN ('rfq_parsed', 'quote_sent', 'invoice_transmitted', 'wa_template_sent', 'sms_sent', 'llm_tokens', 'payment_processed')`
    ),
    check("usage_events_quantity_positive_check", sql`${table.quantity} > 0`),
    check("usage_events_unit_cost_nonnegative_check", sql`${table.unitCostMinor} >= 0`),
    check("usage_events_currency_check", sql`${table.costCurrency} ~ '^[A-Z]{3}$'`)
  ]
);

export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadVersion: integer("payload_version").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state").$type<OutboxState>().notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true, mode: "date" }),
    claimedBy: text("claimed_by"),
    claimToken: uuid("claim_token"),
    lastError: text("last_error"),
    resultRef: text("result_ref"),
    terminalAt: timestamp("terminal_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow()
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "outbox_tenant_id_tenants_id_fk"
    }).onDelete("cascade"),
    uniqueIndex("outbox_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("outbox_tenant_idempotency_unique").on(table.tenantId, table.idempotencyKey),
    index("outbox_ready_idx")
      .on(table.nextAttemptAt, table.createdAt)
      .where(sql`${table.state} IN ('pending', 'processing')`),
    check("outbox_event_type_not_blank", sql`btrim(${table.eventType}) <> ''`),
    check("outbox_payload_version_check", sql`${table.payloadVersion} > 0`),
    check(
      "outbox_state_check",
      sql`${table.state} IN ('pending', 'processing', 'sent', 'failed_permanent', 'cancelled')`
    ),
    check(
      "outbox_attempt_count_check",
      sql`${table.attemptCount} >= 0 AND ${table.attemptCount} <= ${table.maxAttempts}`
    ),
    check("outbox_max_attempts_check", sql`${table.maxAttempts} > 0`)
  ]
);

export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull(),
    outboxId: uuid("outbox_id"),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    status: text("status").$type<IncidentStatus>().notNull().default("open"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" })
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
      name: "incidents_tenant_id_tenants_id_fk"
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tenantId, table.outboxId],
      foreignColumns: [outbox.tenantId, outbox.id],
      name: "incidents_tenant_outbox_fk"
    }).onDelete("cascade"),
    uniqueIndex("incidents_tenant_id_id_unique").on(table.tenantId, table.id),
    uniqueIndex("incidents_tenant_outbox_unique")
      .on(table.tenantId, table.outboxId)
      .where(sql`${table.outboxId} IS NOT NULL`),
    index("incidents_tenant_status_created_idx").on(table.tenantId, table.status, table.createdAt),
    check("incidents_kind_not_blank", sql`btrim(${table.kind}) <> ''`),
    check("incidents_summary_not_blank", sql`btrim(${table.summary}) <> ''`),
    check("incidents_status_check", sql`${table.status} IN ('open', 'resolved')`),
    check(
      "incidents_resolution_check",
      sql`(${table.status} = 'resolved' AND ${table.resolvedAt} IS NOT NULL) OR (${table.status} = 'open' AND ${table.resolvedAt} IS NULL)`
    )
  ]
);

export const schema = {
  tenants,
  users,
  authIdentities,
  authSessions,
  authAccounts,
  authVerifications,
  authRateLimits,
  authMemberships,
  authOnboardingAudit,
  items,
  usageEvents,
  outbox,
  incidents
};

export const tenantTableRegistry = [
  { scopeColumn: "id", sqlName: "tenants", table: tenants },
  { scopeColumn: "tenant_id", sqlName: "users", table: users },
  { scopeColumn: "tenant_id", sqlName: "auth_membership", table: authMemberships },
  { scopeColumn: "tenant_id", sqlName: "items", table: items },
  { scopeColumn: "tenant_id", sqlName: "usage_events", table: usageEvents },
  { scopeColumn: "tenant_id", sqlName: "outbox", table: outbox },
  { scopeColumn: "tenant_id", sqlName: "incidents", table: incidents }
] as const;
