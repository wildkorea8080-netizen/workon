-- Workflow favorites complement the existing users.favorite_agent_ids.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS favorite_workflow_keys text[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION public.set_user_app_favorite(
  p_user_id uuid, p_kind text, p_key text, p_favorite boolean
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE current_ids text[]; updated text[];
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('agent', 'workflow') OR p_key IS NULL OR length(p_key) > 100 OR length(p_key) = 0 OR p_favorite IS NULL THEN
    RAISE EXCEPTION 'invalid favorite' USING ERRCODE = '22023';
  END IF;
  -- Row lock keeps concurrent favorites for different apps from overwriting each other.
  IF p_kind = 'agent' THEN
    SELECT coalesce(favorite_agent_ids, '{}')::text[] INTO current_ids FROM public.users WHERE id = p_user_id FOR UPDATE;
  ELSE
    SELECT favorite_workflow_keys INTO current_ids FROM public.users WHERE id = p_user_id FOR UPDATE;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'user not found' USING ERRCODE = 'P0002'; END IF;
  updated := array_remove(current_ids, p_key);
  IF p_favorite THEN
    IF cardinality(updated) >= 200 THEN RAISE EXCEPTION 'favorite limit' USING ERRCODE = '22023'; END IF;
    updated := array_append(updated, p_key);
  END IF;
  IF p_kind = 'agent' THEN
    UPDATE public.users SET favorite_agent_ids = updated::uuid[] WHERE id = p_user_id;
  ELSE
    UPDATE public.users SET favorite_workflow_keys = updated WHERE id = p_user_id;
  END IF;
  RETURN (SELECT jsonb_build_object('agentIds', coalesce(favorite_agent_ids, '{}'), 'workflowKeys', favorite_workflow_keys) FROM public.users WHERE id = p_user_id);
END;
$$;
REVOKE ALL ON FUNCTION public.set_user_app_favorite(uuid,text,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_user_app_favorite(uuid,text,text,boolean) TO service_role;
NOTIFY pgrst, 'reload schema';
