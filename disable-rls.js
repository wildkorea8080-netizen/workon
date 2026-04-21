const fs = require('fs');
const env = fs.readFileSync('.env.local','utf8').split(/\r?\n/).filter(Boolean).reduce((acc,line)=>{
  const idx=line.indexOf('=');
  if(idx>0){acc[line.slice(0,idx)] = line.slice(idx+1);}
  return acc;
}, {});
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

(async () => {
  console.log('🔧 RLS 비활성화 중...');

  try {
    // 모든 테이블의 RLS 비활성화
    const tables = [
      'users',
      'agents',
      'documents',
      'conversations',
      'messages',
      'report_templates',
      'usage_logs',
      'forbidden_words'
    ];

    for (const table of tables) {
      console.log('📝 ' + table + ' RLS 비활성화...');
      const { error } = await supabase.rpc('exec_sql', {
        sql: 'alter table ' + table + ' disable row level security;'
      });
      if (error) {
        console.log('❌ ' + table + ' RLS 비활성화 실패:', error.message);
      } else {
        console.log('✅ ' + table + ' RLS 비활성화 완료');
      }
    }

    console.log('🎉 RLS 비활성화 작업 완료!');

  } catch (error) {
    console.error('❌ RLS 비활성화 중 오류:', error);
  }
})();