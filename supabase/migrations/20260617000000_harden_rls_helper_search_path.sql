-- ============================================================
-- Migration: 20260617000000_harden_rls_helper_search_path
-- Agente WhatsApp — fix mutable search_path in RLS helper functions
--
-- auth_workspace_ids() and auth_has_role() are SECURITY DEFINER but were created
-- WITHOUT `SET search_path` and reference `memberships` UNQUALIFIED. During RLS
-- evaluation under the `authenticated` role (whose search_path does not include
-- `public`), they fail with 42P01 'relation "memberships" does not exist'.
--
-- This only surfaces once a table HAS rows that force the policy to be evaluated
-- (workspaces / memberships / business_info / prompts / agents all get seeded
-- rows when a workspace is created), which is why getActiveWorkspace() blew up
-- and the agency "Gestionar" button bounced /settings back to /workspaces, while
-- still-empty workspace-scoped tables (conversations, messages, …) looked fine.
--
-- Fix: pin `search_path = ''` and fully-qualify public.memberships — exactly how
-- the already-correct public.is_super_admin() is written. Bodies are otherwise
-- unchanged. CREATE OR REPLACE keeps the existing REVOKE-from-anon grants.
-- ============================================================

CREATE OR REPLACE FUNCTION public.auth_workspace_ids()
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.workspace_id
  FROM public.memberships m
  WHERE m.user_id = auth.uid() AND m.is_active = TRUE;
$$;

CREATE OR REPLACE FUNCTION public.auth_has_role(p_workspace UUID, p_roles public.workspace_role[])
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.user_id = auth.uid()
      AND m.workspace_id = p_workspace
      AND m.is_active = TRUE
      AND m.role = ANY(p_roles)
  );
$$;

-- ============================================================
-- End of migration: 20260617000000_harden_rls_helper_search_path
-- ============================================================
