-- Run only against a newly created, dedicated Keycast database after its
-- upstream migrations. psql variables: tenant_domain, client_id, callback_uri.
BEGIN;
INSERT INTO tenants (domain, name, settings) VALUES (:'tenant_domain', 'Holoboard', '{}') ON CONFLICT (domain) DO NOTHING;
INSERT INTO registered_clients (tenant_id, client_id, name, allowed_redirect_uris)
SELECT id, :'client_id', 'Holoboard', ARRAY[:'callback_uri'] FROM tenants WHERE domain = :'tenant_domain'
ON CONFLICT (tenant_id, client_id) DO NOTHING;
INSERT INTO permissions (identifier, config) VALUES ('allowed_kinds_holoboard', '{"allowed_kinds":[1,1111,9734]}') ON CONFLICT DO NOTHING;
INSERT INTO policies (name, team_id, slug, display_name, description)
SELECT 'Holoboard posts', NULL, 'holoboard', 'Holoboard', 'Create posts, replies and author zap requests'
WHERE NOT EXISTS (SELECT 1 FROM policies WHERE slug = 'holoboard');
INSERT INTO policy_permissions (policy_id, permission_id)
SELECT p.id, k.id FROM policies p CROSS JOIN permissions k
WHERE p.slug = 'holoboard' AND k.identifier = 'allowed_kinds_holoboard'
AND NOT EXISTS (SELECT 1 FROM policy_permissions x WHERE x.policy_id=p.id AND x.permission_id=k.id);
COMMIT;
