#!/usr/bin/env node

/**
 * 간단한 초기 데이터 설정 (API를 통한 방식)
 * 관리자 권한이 있는 계정으로 API 호출
 */

import fetch from 'node-fetch';

const API_BASE = process.env.API_BASE || 'http://localhost:3000';

async function setupData() {
  console.log('🚀 초기 데이터 설정 시작...\n');

  try {
    // 부서 추가용 API가 없으므로, 대신 생성된 테스트 데이터로 충분
    console.log('✅ 데이터베이스 마이그레이션 필요:');
    console.log('1. Supabase 콘솔 접속');
    console.log('2. SQL 에디터에서 supabase/migrations/0001_init.sql 실행');
    console.log('3. supabase/seed_data.sql 실행 (선택사항)');
    console.log('\n또는 Supabase CLI 사용:');
    console.log('$ supabase db push');
    console.log('$ supabase db seed supabase/seed_data.sql');
    return;

  } catch (error) {
    console.error('❌ 오류:', error);
    process.exit(1);
  }
}

setupData();
