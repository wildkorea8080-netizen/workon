/**
 * NODA 웹훅 관리 스크립트 — 읽기 결과 알림을 WORKON으로 받게 건다(2026-10-24).
 *
 *   npm run noda:webhook -- register https://workon-ai.vercel.app/api/noda/webhook
 *   npm run noda:webhook -- list
 *   npm run noda:webhook -- ping wh_…
 *   npm run noda:webhook -- delete wh_…
 *
 * **키 하나(workon)에 하나만 건다** — workon-… 보관함(비서) 전체의 알림이 온다. 여러 개 걸면 같은 알림이 겹쳐 온다.
 * register가 보여 주는 서명 비밀값(secret)은 **이때 한 번만** 나온다. 사용자가 직접 실행하고, 그 값을
 * NODA_WEBHOOK_SECRET으로 .env.local과 Vercel에 넣는다(채팅·저장소에 남기지 않는다). 넣고 배포한 뒤 ping으로 확인한다.
 * 키(NODA_API_KEY)는 .env.local에서 읽고 출력하지 않는다.
 */
import { existsSync, readFileSync } from 'fs';

if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.trimStart().startsWith('#')) {
      const key = line.slice(0, eq).trim();
      if (!process.env[key]) process.env[key] = line.slice(eq + 1).trim();
    }
  }
}
// config.ts가 import 시점에 필수 환경변수를 검사한다. 이 스크립트는 NODA만 부르므로 나머지는 자리표시자로 채운다.
for (const key of [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXTAUTH_URL',
  'NEXTAUTH_SECRET',
  'ANTHROPIC_API_KEY',
]) {
  if (!process.env[key]) process.env[key] = 'noda-webhook-placeholder';
}

const { noda, NodaError } = await import('../src/lib/noda.ts');

const [command, arg] = process.argv.slice(2);

function usage() {
  console.log('사용법: npm run noda:webhook -- register <https 주소> | list | ping <id> | delete <id>');
  process.exit(1);
}

try {
  if (command === 'register') {
    if (!arg || !/^https:\/\//.test(arg)) usage();
    const existing = await noda.listWebhooks();
    if (existing.length > 0) {
      console.log(`이미 걸린 웹훅이 ${existing.length}개 있습니다 — 같은 알림이 겹쳐 오지 않게, 필요 없는 것은 먼저 지우세요:`);
      for (const w of existing) console.log(`  ${w.id}  ${w.url}`);
    }
    const hook = await noda.createWebhook(arg);
    console.log(`걸었습니다: ${hook.id}  ${hook.url}`);
    if (hook.secret) {
      console.log('');
      console.log('서명 비밀값(이번 한 번만 보입니다) — NODA_WEBHOOK_SECRET으로 .env.local과 Vercel에 넣으세요:');
      console.log(hook.secret);
      console.log('');
      console.log(`넣고 배포한 뒤 확인: npm run noda:webhook -- ping ${hook.id}`);
    } else {
      console.log('응답에 서명 비밀값이 없습니다 — NODA 쪽에 확인하세요.');
    }
  } else if (command === 'list') {
    const hooks = await noda.listWebhooks();
    if (hooks.length === 0) console.log('걸린 웹훅이 없습니다.');
    for (const w of hooks) console.log(`${w.id}  ${w.url}  ${(w.events ?? []).join(',') || '(알림 전부)'}`);
  } else if (command === 'ping') {
    if (!arg) usage();
    const r = await noda.pingWebhook(arg);
    console.log(r.ok ? `OK    응답 ${r.status} · ${r.ms}ms` : `FAIL  응답 ${r.status ?? '-'} — 주소·NODA_WEBHOOK_SECRET·배포를 확인하세요`);
    if (!r.ok) process.exitCode = 1;
  } else if (command === 'delete') {
    if (!arg) usage();
    await noda.deleteWebhook(arg);
    console.log(`지웠습니다: ${arg}`);
  } else {
    usage();
  }
} catch (err) {
  const msg =
    err instanceof NodaError
      ? `${err.message}${err.requestId ? ` (요청 번호 ${err.requestId})` : ''}`
      : err instanceof Error
        ? err.message
        : String(err);
  console.log(`실패: ${msg}`);
  process.exitCode = 1;
}
