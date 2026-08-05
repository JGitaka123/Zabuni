CREATE TABLE users (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  phone_e164 text,
  email text,
  name text NOT NULL,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_tenant_id_tenants_id_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT users_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT users_role_check CHECK (role IN ('owner', 'manager', 'sales', 'finance', 'readonly')),
  CONSTRAINT users_contact_check CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL)
);

CREATE UNIQUE INDEX users_tenant_id_id_unique ON users (tenant_id, id);
CREATE UNIQUE INDEX users_tenant_phone_unique ON users (tenant_id, phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX users_tenant_email_unique ON users (tenant_id, lower(email)) WHERE email IS NOT NULL;
