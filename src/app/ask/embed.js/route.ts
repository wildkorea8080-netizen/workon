import { NextResponse, type NextRequest } from 'next/server';
import { normalizeOrgSlug } from '@/lib/org-slug';

export const dynamic = 'force-dynamic';

/**
 * 기관 홈페이지에 붙이는 상담 단추(2026-11-27, 0136) — `<script src=".../ask/embed.js?org={slug}" async></script>`.
 * 오른쪽 아래에 단추를 만들고 누르면 `/ask/{slug}?embed=1`을 작은 창(iframe)으로 띄운다. 외부 라이브러리 없음.
 * 넣을 수 있는 홈페이지는 상담 화면 쪽 frame-ancestors(관리자가 정한 주소)가 막는다 — 이 스크립트는 누구나 받을 수 있다
 */
export async function GET(request: NextRequest) {
  const slug = normalizeOrgSlug(request.nextUrl.searchParams.get('org') ?? '');
  if (!slug.ok) return new NextResponse('/* WORKON: org 값을 확인해 주세요 */', { status: 400, headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
  const src = `${request.nextUrl.origin}/ask/${encodeURIComponent(slug.slug)}?embed=1`;
  const js = `(function(){
  if (window.__workonAsk) return; window.__workonAsk = true;
  var src = ${JSON.stringify(src)};
  var btn = document.createElement('button');
  btn.type = 'button'; btn.setAttribute('aria-label', 'AI 민원 상담 열기'); btn.textContent = 'AI 상담';
  btn.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483000;border:0;border-radius:999px;padding:14px 20px;background:#087f8c;color:#fff;font:600 15px/1 sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.2);cursor:pointer';
  var box = null;
  btn.onclick = function(){
    if (box) { box.remove(); box = null; btn.textContent = 'AI 상담'; btn.setAttribute('aria-label', 'AI 민원 상담 열기'); return; }
    box = document.createElement('iframe');
    box.src = src; box.title = 'AI 민원 상담';
    box.style.cssText = 'position:fixed;right:20px;bottom:80px;z-index:2147483000;width:min(400px,calc(100vw - 40px));height:min(640px,calc(100vh - 120px));border:1px solid #dce3ec;border-radius:16px;background:#fff;box-shadow:0 10px 30px rgba(0,0,0,.25)';
    document.body.appendChild(box);
    btn.textContent = '닫기'; btn.setAttribute('aria-label', 'AI 민원 상담 닫기');
  };
  if (document.body) document.body.appendChild(btn); else document.addEventListener('DOMContentLoaded', function(){ document.body.appendChild(btn); });
})();`;
  return new NextResponse(js, { headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}
