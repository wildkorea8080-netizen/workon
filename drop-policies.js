const fs = require('fs');
const env = fs.readFileSync('.env.local','utf8').split(/\r?\n/).filter(Boolean).reduce((acc,line)=>{
  const idx=line.indexOf('=');
  if(idx>0){acc[line.slice(0,idx)] = line.slice(idx+1);}
  return acc;
}, {});
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  console.log('🔧 재귀 RLS 정책 삭제 중...');

  try {
    // 각 정책을 개별적으로 삭제
    const queries = [
      'drop policy if exists "agents_select_department" on agents;',
      'drop policy if exists "documents_select_department" on documents;',
      'drop policy if exists "templates_select_department" on report_templates;'
    ];

    for (let i = 0; i < queries.length; i++) {
      console.log('📝 정책 ' + (i+1) + ' 삭제...');
      const { error } = await supabase.rpc('exec_sql', { sql: queries[i] });
      if (error) {
        console.log('❌ 정책 삭제 실패:', error.message);
      } else {
        console.log('✅ 정책 삭제 완료');
      }
    }

    console.log('🎉 정책 삭제 작업 완료!');

  } catch (error) {
    console.error('❌ 정책 삭제 중 오류:', error);
  }
})();