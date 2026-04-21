-- Seed data for WORKON MVP demo environment
-- Run after migrations: supabase db push && supabase db seed --file=seed_data.sql

-- Departments
insert into departments (id, name, slug, description, created_at, updated_at) values
('11111111-1111-1111-1111-111111111111', '한국사회복지협회', 'welfare-association', '공공복지 서비스 기획 및 운영을 지원하는 공공기관 연합체입니다.', now(), now()),
('22222222-2222-2222-2222-222222222222', '국립연구개발센터', 'research-center', '정부 연구 프로젝트와 보고서 작성 지원을 담당하는 연구개발 기관입니다.', now(), now()),
('33333333-3333-3333-3333-333333333333', '시민참여위원회', 'citizen-engagement', '시민 의견 수집과 참여 프로젝트를 운영하는 공공 협의체입니다.', now(), now());

-- Users
insert into users (id, email, full_name, role, department_id, created_at, updated_at) values
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'admin@welfare.org', '김미영', 'ADMIN', '11111111-1111-1111-1111-111111111111', now(), now()),
('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'park.sujin@welfare.org', '박수진', 'USER', '11111111-1111-1111-1111-111111111111', now(), now()),
('cccccccc-cccc-cccc-cccc-cccccccccccc', 'choi.yh@welfare.org', '최영훈', 'USER', '11111111-1111-1111-1111-111111111111', now(), now()),
('dddddddd-dddd-dddd-dddd-dddddddddddd', 'admin@researchcenter.kr', '이준호', 'ADMIN', '22222222-2222-2222-2222-222222222222', now(), now()),
('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'jung.deun@researchcenter.kr', '정다은', 'USER', '22222222-2222-2222-2222-222222222222', now(), now()),
('ffffffff-ffff-ffff-ffff-ffffffffffff', 'yoon.haneul@citizen.kr', '윤하늘', 'USER', '33333333-3333-3333-3333-333333333333', now(), now());

-- Agents
insert into agents (id, department_id, name, description, system_prompt, config, is_active, created_by, updated_by, created_at, updated_at) values
('aaaa1111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', '복지정책 도우미', '사회복지 정책, 지원사업 안내, 시민 문의 대응에 특화된 AI 에이전트입니다.', '당신은 한국사회복지협회의 공공복지 지원 담당자입니다. 친절하고 정확한 한국어 문체로 답변하세요. 정책 안내, 신청 절차, 서비스 대상자 정보를 중심으로 답변하세요.', '{"temperature":0.2, "max_tokens":800}', true, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now(), now()),
('bbbb1111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '연구기획 매니저', '연구 보고서 요약, 연구 계획서 작성 및 검토를 지원하는 AI 에이전트입니다.', '당신은 정부 연구개발센터의 전문 연구기획자입니다. 공식적이고 분석적인 한국어 문체로 답변하세요. 연구 목적, 방법, 결과 요약에 집중하십시오.', '{"temperature":0.15, "max_tokens":900}', true, 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'dddddddd-dddd-dddd-dddd-dddddddddddd', now(), now()),
('cccc1111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '시민참여 상담관', '시민 의견 수집, 공청회 준비, 참여 절차 안내를 지원하는 AI 에이전트입니다.', '당신은 시민참여위원회의 공공 참여 상담관입니다. 공감적이고 명확한 한국어 문체로 답변하세요. 참여 방법, 일정, 의견 제출 절차를 중심으로 안내하십시오.', '{"temperature":0.25, "max_tokens":800}', true, 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'ffffffff-ffff-ffff-ffff-ffffffffffff', now(), now());

-- Report Templates
insert into report_templates (id, department_id, created_by, name, description, content, schema, is_active, version, created_at, updated_at) values
('aaaabbbb-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '사회복지 사업 성과 보고서', '사업 목표, 활동 내용, 성과 및 향후 계획을 정리하는 보고서 템플릿입니다.', '사업명: {{project_name}}\n보고기간: {{period}}\n담당부서: {{department}}\n\n요약: {{summary}}\n\n주요 성과:\n{{outcomes}}\n\n향후 계획:\n{{next_steps}}', '{"fields":[{"key":"project_name","label":"사업명","type":"text","required":true},{"key":"period","label":"보고기간","type":"text","required":true},{"key":"department","label":"담당부서","type":"text","required":true},{"key":"summary","label":"핵심 요약","type":"textarea","required":true},{"key":"outcomes","label":"주요 성과","type":"textarea","required":true},{"key":"next_steps","label":"향후 계획","type":"textarea","required":true}]}', true, 1, now(), now()),
('bbbbcccc-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', '연구 결과 요약 보고서', '연구 개요, 방법론, 주요 발견 및 제언을 포함하는 보고서 템플릿입니다.', '연구명: {{project_name}}\n연구기간: {{period}}\n연구책임자: {{lead_researcher}}\n\n연구 개요: {{summary}}\n\n주요 결과: {{key_findings}}\n\n정책 제언: {{recommendations}}', '{"fields":[{"key":"project_name","label":"연구명","type":"text","required":true},{"key":"period","label":"연구기간","type":"text","required":true},{"key":"lead_researcher","label":"책임자","type":"text","required":true},{"key":"summary","label":"연구 개요","type":"textarea","required":true},{"key":"key_findings","label":"주요 결과","type":"textarea","required":true},{"key":"recommendations","label":"정책 제언","type":"textarea","required":true}]}', true, 1, now(), now()),
('ccccdddd-3333-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333', '시민 참여 활동 결과 보고서', '공청회 및 참여 프로젝트 결과를 정리하여 공유하는 보고서 템플릿입니다.', '프로젝트명: {{project_name}}\n운영기간: {{period}}\n참여인원: {{participants}}\n\n활동 내용: {{activities}}\n\n주요 의견: {{feedback}}\n\n향후 개선 사항: {{next_steps}}', '{"fields":[{"key":"project_name","label":"프로젝트명","type":"text","required":true},{"key":"period","label":"운영기간","type":"text","required":true},{"key":"participants","label":"참여인원","type":"number","required":true},{"key":"activities","label":"활동 내용","type":"textarea","required":true},{"key":"feedback","label":"주요 의견","type":"textarea","required":true},{"key":"next_steps","label":"향후 개선 사항","type":"textarea","required":true}]}', true, 1, now(), now());

-- Forbidden Words
insert into forbidden_words (id, department_id, word, context, is_active, created_at, updated_at) values
('aaaaword-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', '차별', '공공복지 안내 문서에서 차별적 표현을 방지합니다.', true, now(), now()),
('aaaaword-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', '부적절', '대상자 안내 문서에서 부적절한 표현을 필터링합니다.', true, now(), now()),
('bbbboord-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '기밀', '연구 자료 및 보고서에서 기밀성을 유지합니다.', true, now(), now()),
('bbbboord-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', '비공개', '미공개 연구 데이터가 외부로 노출되지 않도록 합니다.', true, now(), now()),
('cccword-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '혐오', '시민 참여 커뮤니케이션에서 혐오 표현을 금지합니다.', true, now(), now()),
('cccword-2222-2222-2222-333333333333', '33333333-3333-3333-3333-333333333333', '모욕', '민원 및 의견 수렴 과정에서 모욕적 표현을 차단합니다.', true, now(), now());

-- Sample Usage Logs
insert into usage_logs (id, department_id, user_id, action, resource_type, resource_id, details, created_at) values
('log-0001-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'login', 'user', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '{"ip":"203.0.113.10","browser":"Chrome"}', now()),
('log-0002-2222-2222-2222-222222222222', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'create_agent', 'agent', 'bbbb1111-1111-1111-1111-111111111111', '{"name":"연구기획 매니저"}', now()),
('log-0003-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'upload_document', 'document', null, '{"file_name":"2026_복지사업_참여자_현황.pdf","file_type":"application/pdf"}', now()),
('log-0004-3333-3333-3333-333333333333', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'generate_report', 'report_template', 'ccccdddd-3333-3333-3333-333333333333', '{"template_name":"시민 참여 활동 결과 보고서"}', now()),
('log-0005-2222-2222-2222-222222222222', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'create_conversation', 'conversation', null, '{"agent":"연구기획 매니저","topic":"자료 분석"}', now());
