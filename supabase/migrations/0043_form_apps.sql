-- Extend versioned agents with bounded form apps. Existing agents stay NULL.
ALTER TABLE public.agents ADD COLUMN IF NOT EXISTS app_definition jsonb;
ALTER TABLE public.agents ADD CONSTRAINT agents_app_definition_object CHECK (app_definition IS NULL OR jsonb_typeof(app_definition) = 'object');

CREATE OR REPLACE FUNCTION agent_snapshot(a agents)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'name',            a.name,
    'description',     a.description,
    'icon',            a.icon,
    'color',           a.color,
    'category',        a.category,
    'usage_guide',     a.usage_guide,
    'starter_prompts', to_jsonb(a.starter_prompts),
    'system_prompt',   a.system_prompt,
    'model_id',        a.model_id,
    'app_definition',  a.app_definition,
    'capabilities',    a.capabilities,
    'template_ids',    COALESCE(
                         -- 같은 시각에 만든 양식도 순서가 흔들리지 않게 id로 한 번 더 정렬
                         (SELECT jsonb_agg(t.id ORDER BY t.created_at, t.id)
                            FROM agent_templates t
                           WHERE t.agent_id = a.id AND t.retired_at IS NULL),
                         '[]'::jsonb))
$$;

CREATE OR REPLACE FUNCTION save_agent(
  p_agent_id     uuid,
  p_base_version integer,
  p_patch        jsonb,
  p_actor        uuid,
  p_kind         text,
  p_detail       jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  cur          agents%ROWTYPE;
  saved        agents%ROWTYPE;
  before_snap  jsonb;
  after_snap   jsonb;
  active_count integer;
BEGIN
  IF p_kind NOT IN ('settings', 'revert', 'preset_update') THEN
    RAISE EXCEPTION 'save_agent: 허용되지 않는 kind %', p_kind;
  END IF;

  SELECT * INTO cur FROM agents WHERE id = p_agent_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- 함께 고칠 때 덮어쓰기 막기
  IF p_base_version IS DISTINCT FROM cur.version THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'conflict', 'current_version', cur.version);
  END IF;

  before_snap := agent_snapshot(cur);

  IF p_patch ? 'template_ids' THEN
    UPDATE agent_templates SET retired_at = now()
     WHERE agent_id = p_agent_id AND retired_at IS NULL
       AND id::text NOT IN (SELECT jsonb_array_elements_text(p_patch -> 'template_ids'));
    UPDATE agent_templates SET retired_at = NULL
     WHERE agent_id = p_agent_id AND retired_at IS NOT NULL
       AND id::text IN (SELECT jsonb_array_elements_text(p_patch -> 'template_ids'));
    SELECT count(*) INTO active_count
      FROM agent_templates WHERE agent_id = p_agent_id AND retired_at IS NULL;
    IF active_count > 10 THEN
      RAISE EXCEPTION '양식은 비서당 10개까지입니다.' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE agents SET
    name            = CASE WHEN p_patch ? 'name'          THEN p_patch ->> 'name'          ELSE name END,
    description     = CASE WHEN p_patch ? 'description'   THEN p_patch ->> 'description'   ELSE description END,
    icon            = CASE WHEN p_patch ? 'icon'          THEN p_patch ->> 'icon'          ELSE icon END,
    color           = CASE WHEN p_patch ? 'color'         THEN p_patch ->> 'color'         ELSE color END,
    category        = CASE WHEN p_patch ? 'category'      THEN p_patch ->> 'category'      ELSE category END,
    usage_guide     = CASE WHEN p_patch ? 'usage_guide'   THEN p_patch ->> 'usage_guide'   ELSE usage_guide END,
    system_prompt   = CASE WHEN p_patch ? 'system_prompt' THEN p_patch ->> 'system_prompt' ELSE system_prompt END,
    model_id        = CASE WHEN p_patch ? 'model_id'      THEN p_patch ->> 'model_id'      ELSE model_id END,
    starter_prompts = CASE
                        WHEN NOT (p_patch ? 'starter_prompts') THEN starter_prompts
                        WHEN jsonb_typeof(p_patch -> 'starter_prompts') = 'array'
                          THEN ARRAY(SELECT jsonb_array_elements_text(p_patch -> 'starter_prompts'))
                        ELSE NULL
                      END,
    capabilities    = CASE
                        WHEN NOT (p_patch ? 'capabilities') THEN capabilities
                        WHEN jsonb_typeof(p_patch -> 'capabilities') = 'object' THEN p_patch -> 'capabilities'
                        ELSE '{}'::jsonb
                      END,
    app_definition  = CASE WHEN p_patch ? 'app_definition' THEN nullif(p_patch -> 'app_definition', 'null'::jsonb) ELSE app_definition END,
    version         = cur.version + 1,
    -- 기본 비서 갱신(p_actor NULL)은 '사람이 고친 비서' 표시를 남기지 않는다
    updated_by      = COALESCE(p_actor, updated_by),
    updated_at      = now()
  WHERE id = p_agent_id
  RETURNING * INTO saved;

  after_snap := agent_snapshot(saved);

  INSERT INTO agent_history (agent_id, kind, version, snapshot, changed_by, detail)
  VALUES (
    p_agent_id, p_kind, saved.version, after_snap, p_actor,
    COALESCE(p_detail, '{}'::jsonb) || jsonb_build_object('fields', COALESCE(
      (SELECT jsonb_agg(n.key ORDER BY n.key)
         FROM jsonb_each(after_snap) AS n(key, value)
        WHERE n.value IS DISTINCT FROM before_snap -> n.key),
      '[]'::jsonb)));

  RETURN jsonb_build_object('ok', true, 'version', saved.version);
END $$;
NOTIFY pgrst, 'reload schema';
