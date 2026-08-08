DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_available_extensions
    WHERE name = 'vector'
  ) THEN
    RAISE EXCEPTION 'pgvector extension is unavailable; install pgvector before Q-3 deployment';
  END IF;
END
$preflight$;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE TABLE item_embeddings (
  item_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  embedding vector(1024) NOT NULL,
  normalized_text text NOT NULL,
  content_hash text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  model_version text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_embeddings_tenant_item_unique UNIQUE (tenant_id, item_id),
  CONSTRAINT item_embeddings_tenant_item_fk
    FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT item_embeddings_normalized_text_not_blank
    CHECK (btrim(normalized_text) <> ''),
  CONSTRAINT item_embeddings_normalized_text_length_check
    CHECK (char_length(normalized_text) <= 1000),
  CONSTRAINT item_embeddings_content_hash_check
    CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT item_embeddings_provider_check
    CHECK (btrim(provider) <> '' AND char_length(provider) <= 100),
  CONSTRAINT item_embeddings_model_check
    CHECK (btrim(model) <> '' AND char_length(model) <= 100),
  CONSTRAINT item_embeddings_model_version_check
    CHECK (btrim(model_version) <> '' AND char_length(model_version) <= 100)
);

CREATE INDEX item_embeddings_embedding_hnsw_idx
  ON item_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE item_aliases (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  item_id uuid NOT NULL,
  alias_text text NOT NULL,
  source text NOT NULL,
  hit_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_aliases_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT item_aliases_tenant_item_fk
    FOREIGN KEY (tenant_id, item_id) REFERENCES items (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT item_aliases_alias_text_check
    CHECK (btrim(alias_text) <> '' AND char_length(alias_text) <= 1000),
  CONSTRAINT item_aliases_source_check CHECK (source IN ('human', 'accepted_match')),
  CONSTRAINT item_aliases_hit_count_nonnegative_check CHECK (hit_count >= 0)
);

CREATE UNIQUE INDEX item_aliases_tenant_alias_casefold_unique
  ON item_aliases (tenant_id, lower(alias_text));
CREATE INDEX item_aliases_tenant_item_idx ON item_aliases (tenant_id, item_id);

CREATE TABLE catalog_alias_quotas (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  alias_count integer NOT NULL,
  CONSTRAINT catalog_alias_quotas_count_check CHECK (alias_count BETWEEN 0 AND 10000)
);

CREATE OR REPLACE FUNCTION app.maintain_item_alias_quota()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  updated_tenant uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.catalog_alias_quotas (tenant_id, alias_count)
    VALUES (NEW.tenant_id, 1)
    ON CONFLICT (tenant_id) DO UPDATE
      SET alias_count = public.catalog_alias_quotas.alias_count + 1
      WHERE public.catalog_alias_quotas.alias_count < 10000
    RETURNING tenant_id INTO updated_tenant;
    IF updated_tenant IS NULL THEN
      RAISE EXCEPTION 'Tenant alias limit reached' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  UPDATE public.catalog_alias_quotas
  SET alias_count = greatest(alias_count - 1, 0)
  WHERE tenant_id = OLD.tenant_id;
  RETURN OLD;
END
$function$;

CREATE TRIGGER item_aliases_limit_guard
BEFORE INSERT OR DELETE ON item_aliases
FOR EACH ROW EXECUTE FUNCTION app.maintain_item_alias_quota();

CREATE TABLE catalog_match_rate_limits (
  key text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  request_count integer NOT NULL,
  window_started_at timestamptz NOT NULL,
  CONSTRAINT catalog_match_rate_limits_key_check
    CHECK (btrim(key) <> '' AND char_length(key) <= 150),
  CONSTRAINT catalog_match_rate_limits_count_check
    CHECK (request_count BETWEEN 1 AND 1000)
);

ALTER TABLE item_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_embeddings FORCE ROW LEVEL SECURITY;
CREATE POLICY item_embeddings_read ON item_embeddings AS PERMISSIVE FOR SELECT TO zabuni_app
  USING (true);
CREATE POLICY item_embeddings_insert ON item_embeddings AS PERMISSIVE FOR INSERT TO zabuni_app
  WITH CHECK (true);
CREATE POLICY item_embeddings_update ON item_embeddings AS PERMISSIVE FOR UPDATE TO zabuni_app
  USING (true) WITH CHECK (true);
CREATE POLICY item_embeddings_delete ON item_embeddings AS PERMISSIVE FOR DELETE TO zabuni_app
  USING (true);
CREATE POLICY item_embeddings_boundary ON item_embeddings AS RESTRICTIVE FOR ALL TO zabuni_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE item_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY item_aliases_read ON item_aliases AS PERMISSIVE FOR SELECT TO zabuni_app
  USING (true);
CREATE POLICY item_aliases_insert ON item_aliases AS PERMISSIVE FOR INSERT TO zabuni_app
  WITH CHECK (true);
CREATE POLICY item_aliases_update ON item_aliases AS PERMISSIVE FOR UPDATE TO zabuni_app
  USING (true) WITH CHECK (true);
CREATE POLICY item_aliases_delete ON item_aliases AS PERMISSIVE FOR DELETE TO zabuni_app
  USING (true);
CREATE POLICY item_aliases_boundary ON item_aliases AS RESTRICTIVE FOR ALL TO zabuni_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE catalog_alias_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_alias_quotas FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_alias_quotas_owner ON catalog_alias_quotas AS PERMISSIVE FOR ALL TO zabuni_owner
  USING (true)
  WITH CHECK (true);
CREATE POLICY catalog_alias_quotas_read ON catalog_alias_quotas AS PERMISSIVE FOR SELECT TO zabuni_app
  USING (true);
CREATE POLICY catalog_alias_quotas_boundary ON catalog_alias_quotas AS RESTRICTIVE FOR ALL TO zabuni_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE catalog_match_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_match_rate_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_match_rate_limits_read ON catalog_match_rate_limits AS PERMISSIVE FOR SELECT TO zabuni_app
  USING (true);
CREATE POLICY catalog_match_rate_limits_insert ON catalog_match_rate_limits AS PERMISSIVE FOR INSERT TO zabuni_app
  WITH CHECK (true);
CREATE POLICY catalog_match_rate_limits_update ON catalog_match_rate_limits AS PERMISSIVE FOR UPDATE TO zabuni_app
  USING (true) WITH CHECK (true);
CREATE POLICY catalog_match_rate_limits_boundary ON catalog_match_rate_limits AS RESTRICTIVE FOR ALL TO zabuni_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON item_embeddings, item_aliases, catalog_alias_quotas, catalog_match_rate_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON item_embeddings, item_aliases TO zabuni_app;
GRANT SELECT ON catalog_alias_quotas TO zabuni_app;
GRANT SELECT, INSERT, UPDATE ON catalog_match_rate_limits TO zabuni_app;
REVOKE ALL ON FUNCTION app.maintain_item_alias_quota() FROM PUBLIC;
