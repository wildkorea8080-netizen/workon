"""Read public Allganize app pages; retain bounded evidence and build a research catalog."""
import concurrent.futures
import datetime
import hashlib
import html
import json
import re
import urllib.request
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = 'https://www.allganize.ai'
INDEX = BASE + '/ja/app-market/llm-apps'
TODAY = '2026-10-28'

# Korean labels and public-sector uses below are analyst proposals, not vendor claims.
ROWS = '''039|격려 문구 상담|업무 연관 낮음; 초기 범위 제외
059|전화 상담 코칭|민원 상담 기록의 응대 품질 점검 후보
013|프롬프트 생성|업무 비서 지시문 초안 구성
055|영업 역할 연습|민원 응대 교육 시나리오로 전환
079|프로젝트 위험 검토|사업계획의 위험·대응 목록 작성
052|일대일 면담 지원|업무 면담 질문 초안
092|AI 문서 적합성 점검|ReadLayer 읽기 품질·구조 점검 화면
033|BANTC 항목 정리|상담 메모의 정해진 항목 추출 방식 참고
017|엑셀 함수 도움말|직원이 설명한 계산에 맞는 수식 제안
060|FAQ 유지관리|문의 기록을 FAQ 후보로 정리 후 검토
004|FAQ 기반 응답|기관 검증 FAQ를 근거로 질의응답
095|FAQ 정비|유사·중복·저사용 FAQ 검토 목록
106|문서에서 FAQ 생성|기관 매뉴얼을 검토 가능한 FAQ 초안으로
054|이미지 도표 분석|스캔 표 추출·원본 대조에 활용
098|IT 지식 검색·문제 해결|기관 전산 매뉴얼 기반 직원 지원
108|LLM·웹 정보 응답|기관 자료와 외부 공개 정보의 범위 구분
036|LLM 활용 제안|업무 유형별 AI 사용 예시 안내
019|Mac 문제 해결|기관 기기 정책에 맞는 전산 도움말
056|NDA 검토|표준 계약 대비 조항 누락·차이 확인
043|OKR 설정|확정 실적에 근거한 부서 목표 초안
025|PEST 분석|정책·경제·사회·기술 환경 조사
096|발표자료 개요·VBA 생성|발표 개요 참고; 임의 VBA 실행은 초기 제외
011|PR 기사 초안|확인된 사업자료로 보도자료 초안
103|RFP 작성 지원|제안요청서·과업지시서 필수 항목 초안
102|SaaS 약관 검토|서비스 이용약관의 확인 사항 추출
028|SPIN 질문 생성|사업 수요조사·상담 질문으로 전환
049|SQL DDL·쿼리 작성|읽기 전용 통계 질의 보조부터 검토
034|SWOT 분석|기관·사업 환경의 근거 있는 분석
018|Windows 문제 해결|기관 전산 FAQ와 연계한 직원 지원
005|메일 초안 작성|직원이 확인한 사실로 안내 메일 작성
089|하도급법 적용 점검|일본 법률 앱; 국내 기준을 따로 설계
068|사업 내용 산업 분류|국내 분류체계 기반 후보 제안으로 전환
041|인사평가 피드백 문안|확인된 평가 내용의 표현 보조만 검토
022|업무 진행 조언|매뉴얼 기반 처리 절차 안내
80|기획서 개요 작성|사업기획 목차·필요자료 초안
086|세미나 기획·모집 지원|기관 행사 개요·제목·안내문 초안
026|회의 용어 검색|기관 용어집·공개 자료 확인
020|회의 안건 작성|이전 회의의 미결 안건을 다음 안건으로
058|보도자료 제목 생성|확정 내용에서 제목 후보 생성
012|홍보 문구 작성|기관 사업 안내 문구 초안
105|고객별 영업계획|협력기관 현황·협업계획으로 전환
048|광고 문구 작성|시민 대상 안내 제목 후보
082|문서 양식 구성|기관 승인 양식의 항목 설계 보조
107|페르소나 작성|사업 대상자 유형의 가설 정리
074|코드 수정 지원|전산 담당자 보조; 일반 직원 초기 범위 제외
081|구내식당 메뉴 제안|핵심 업무 연관 낮음; 초기 제외
035|파이브 포스 분석|산업 환경 조사 참고
045|뉴스레터 분석|기관 소식지 반응·개선안 분석
064|계정과목 분류 지원|회계 기준에 따른 후보 제시; 확정은 담당자
002|인지세 점검|일본 세법 앱; 국내 기준 검증 없이는 미제공
044|미팅 요청 편지|기관 간 협조·면담 요청 초안
075|리뷰 답변 생성|기관 서비스 이용 의견 회신 초안
076|MECE 기획 검토|사업계획 검토 항목 누락 점검
078|상품 이미지 홍보 문구|행사·시설 안내문 초안 후보
046|FAQ 검색 후 회신 작성|기관 근거 검색과 민원 회신 초안 연결
062|문서 기반 질의응답|ReadLayer 기반 규정·매뉴얼 확인
087|일반 생성형 대화|가벼운 질문과 작성의 공통 입구
093|챗봇 이용 데이터 분석|비서 미응답·반복 문의 개선
003|계약 조항 추출·비교|계약 금액·기간·조건과 표준안 차이 대조
042|재교육 학습계획|직무교육 계획 초안
084|정관 분석|기관 정관의 권한·절차·요건 추출
014|불만 응대 문구|확인 사실과 기관 지침에 맞는 회신
097|심리적 안전성 점검|인사 판단 자동화는 제외; 검토 참고만
099|아이디어 대화|기획 초안 검토와 질문 정리
053|채용 면접 질문|공통 직무역량 질문 초안
091|페르미 추정|가정 기반 기획 참고; 확정 실적으로 사용 금지
031|마케팅 계획|공공사업 홍보계획 초안으로 전환
040|문법 점검|공문·안내문 표현 교정
090|문장 교정|기관명·날짜·용어 일관성 검토
083|표현 변환|개조식·공문체·시민 안내체 전환
024|메일 문구 점검|수신 대상에 맞는 표현 검토
038|신입 환영 문구|신규 직원 안내·온보딩 자료
030|신사업 아이디어|기관 목적과 근거 자료에 맞는 사업 후보
066|표시광고법 점검|일본 법률 앱; 국내 법령으로 별도 평가
077|주주총회 예상 질문|이사회·의회·평가 예상 질의 초안으로 전환
071|채용 제안 메일|채용 안내 문안 보조
088|캐릭터 설정|기관 홍보 아이디어 참고; 후순위
070|대화 시작 아이디어|핵심 업무 연관 낮음; 후순위
094|채용공고 표현 점검|직무와 무관한 표현·누락 항목 검토
009|채용공고 생성|확정 채용 조건에서 공고 초안
008|채용조건·이력 대조|채용 자격 증빙 대조 보조; 자동 선발 제외
029|교육 프로그램 제안|기관 직무교육 구성 초안
109|사내 자료 Deep Research|내부 근거와 공개 자료로 정책·사업 조사
047|조직 문제 해결 제안|기관 현안의 대안·확인사항 정리
006|기안서 작성|기관 양식에 맞춘 기안 초안과 파일
085|업무 관리표 작성|요청사항·담당 확인·기한 관리표
073|설문 결과 분석|만족도 계산·의견 분류·개선안
007|번역|기관 용어집·원문 대조가 있는 번역
050|약기법 점검|일본 특수 규제 앱; 초기 범위 제외
072|스프레드시트 오류 해결|취합 파일 수식·데이터 오류 안내
065|판매 제안 지원|유관기관 수요 분석으로 전환
027|다수 일간·주간보고 요약|부서 주간보고를 항목별 종합
061|문서 요약|공문·보고서의 핵심과 요청사항 정리
032|해설형 블로그 초안|정책 설명·기관 소식 초안
021|뉴스 요약·번역|기관 관심 정책·사업 동향 요약
023|설문 질문 생성|사업 평가·수요조사 설문 초안
057|청구·입금 대조|청구·수납·증빙 불일치 검토
051|강연 제목 생성|교육·행사 제목 후보
001|회의록 작성|결정·미결·후속조치 정리
015|발표자료 기획|보고 발표 제목·목차 구성'''
MAPPING = {r.split('|', 2)[0]: r.split('|', 2)[1:] for r in ROWS.splitlines()}

class Text(HTMLParser):
    def __init__(self):
        super().__init__(); self.skip = 0; self.parts = []
    def handle_starttag(self, tag, attrs):
        if tag in ('style', 'script'): self.skip += 1
    def handle_endtag(self, tag):
        if tag in ('style', 'script'): self.skip = max(0, self.skip - 1)
    def handle_data(self, data):
        if not self.skip and data.strip(): self.parts.append(data.strip())

def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'WORKON-public-product-research/1.0'})
    return urllib.request.urlopen(req, timeout=25).read()

def text(fragment):
    p = Text(); p.feed(fragment); return ' '.join(p.parts)

def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    evidence = ROOT / 'evidence' / 'apps'; evidence.mkdir(parents=True, exist_ok=True)
    raw = fetch(INDEX)
    cards = re.findall(r'<a\b[^>]*href="([^"]*/ja/app-market/ja-app-markets/[^\"]+)"[^>]*>(.*?)</a>', raw.decode(), re.S)
    apps = []
    for href, body in cards:
        app_id = href.rsplit('/', 1)[-1]
        title = re.search(r'<h5\b[^>]*>(.*?)</h5>', body, re.S)
        category = re.search(r'<div\b[^>]*class="appcardcategory"[^>]*>(.*?)</div>', body, re.S)
        assert title and category and app_id in MAPPING, app_id
        ko, proposed = MAPPING[app_id]
        apps.append({'id': 'alli-ja-' + app_id, 'vendor_app_id': app_id,
                     'original_title_ja': text(title.group(1)), 'analyst_title_ko': ko,
                     'vendor_category': text(category.group(1)),
                     'official_detail_url': BASE + href if href.startswith('/') else href,
                     'discovery_source': INDEX,
                     'analyst_public_sector_adaptation': proposed,
                     'evidence_level': 'public_catalog',
                     'authenticated_execution': False})
    assert len(apps) == 100 and len({a['id'] for a in apps}) == 100
    def enrich(app):
        try:
            body = fetch(app['official_detail_url'])
            p = Text(); p.feed(body.decode()); s = '\n'.join(p.parts)
            start = s.find('Overview')
            end = s.find('User Resources', start)
            excerpt = s[start + len('Overview'):end].strip() if start >= 0 and end > start else ''
            # A bounded excerpt per individual source; no whole-page mirror.
            excerpt = excerpt[:2400]
            record = {'url': app['official_detail_url'], 'retrieved_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      'sha256': hashlib.sha256(body).hexdigest(), 'http_status': 200,
                      'overview_excerpt_ja': excerpt, 'purpose': 'public product capability research; no authenticated execution'}
            (evidence / (app['vendor_app_id'] + '.json')).write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            app['detail_fetch_status'] = 'ok'
            app['detail_evidence_file'] = 'evidence/apps/' + app['vendor_app_id'] + '.json'
            app['evidence_level'] = 'public_detail' if excerpt else 'public_catalog'
        except Exception as exc:
            app['detail_fetch_status'] = 'unavailable'
            app['detail_error'] = str(exc)
        return app
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        apps = list(pool.map(enrich, apps))
    templates = [
        ('Proposal Content Generator', '제안서 구성 작성', 'RFP와 기존 제안 자료에서 필요한 부분 초안', '제안요청 분석·과거 답변 재사용'),
        ('AI PowerPoint Builder', 'PPT 제작', '대화·참고자료에서 편집 가능한 PPTX', '기관 발표자료 작성'),
        ('AI Document Screening', '문서 심사 보조', 'OCR·체크리스트·점검 결과', '접수자료 완비성 확인'),
        ('Claude Usage Insights', 'AI 이용 분석', '모델·팀 사용 현황 대시보드', '기관별 비용·이용 관리'),
        ('API Navigator', 'API 탐색 도구', '명세에서 호출 가능한 항목 구성', '승인된 공공 API 연결 도구'),
        ('Company Research', '기업 조사', '기업 정보와 출처 정리', '협력기관·사업 조사'),
        ('Reception Management', '방문 접수', 'QR·담당자 알림·출입 표식', '방문 접수 업무; 후순위'),
        ('Video to Manual', '영상 매뉴얼', '화면녹화에서 절차 문서', '내부 업무 매뉴얼 작성; 후순위'),
    ]
    data = {'research_date_kst': TODAY,
            'scope': '100 publicly listed Japanese Alli LLM App Market entries and 8 separately advertised Coworker templates; not an authenticated or current Korean tenant inventory',
            'observed_catalog_source': INDEX, 'observed_app_count': len(apps),
            'notes': ['Original titles and categories are public catalog observations.',
                      'Korean labels and public-sector adaptations are analyst proposals.',
                      'Detail excerpts and retrieval evidence are retained separately.',
                      'Legacy model labels and Japan-specific legal apps do not establish current Korean availability.'],
            'apps': apps,
            'coworker_templates': [{'original_name': n, 'analyst_title_ko': ko, 'observed_summary_ko': summary,
                                   'analyst_public_sector_adaptation': adapt, 'source': BASE + '/',
                                   'evidence_level': 'public_marketing_description', 'authenticated_execution': False}
                                  for n, ko, summary, adapt in templates]}
    (ROOT / 'app-catalog.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    counts = Counter(a['vendor_category'] for a in apps)
    md = ['# 알리웍스 공개 앱 카탈로그', '', '조사일: 2026-10-28 · 공개 목록 100개 + 별도 Coworker 템플릿 8개', '',
          '공식 일본어 앱 마켓의 앱 제목·분류·상세 링크를 관찰했다. 한국어 이름과 공공기관 적용안은 WORKON을 위한 분석자의 제안이다. 로그인 실행·앱 설치·실제 산출물 시험은 하지 않았다. 이 목록이 현재 한국 SaaS 계정에 모두 제공된다는 뜻은 아니다. 구형 모델명이 들어간 앱과 일본 법률 앱은 지역·시점별 검증이 필요하다.', '',
          '[공식 앱 목록](' + INDEX + ') · [기계 판독 목록](app-catalog.json)', '',
          '상세 페이지의 제한된 제품 설명과 조회 시각·해시를 `evidence/apps/{앱ID}.json`에 기록했다. 입력·처리·출력을 상세 페이지가 밝히지 않으면 확인되지 않은 것으로 본다.', '',
          '## 분류별 수', '', '| 공개 분류 | 수 |', '|---|---:|']
    md += ['| ' + k + ' | ' + str(v) + ' |' for k, v in sorted(counts.items())]
    md += ['', '## 앱 목록', '', '| ID | 공식 일본어 제목 | 한국어 표기(분석자) | 공개 분류 | WORKON 적용 제안 | 상세 근거 |', '|---|---|---|---|---|---|']
    for a in apps:
        status = '상세 설명 확인' if a['evidence_level'] == 'public_detail' else '목록만 확인'
        md.append('| ' + ' | '.join([a['vendor_app_id'], '[' + a['original_title_ja'] + '](' + a['official_detail_url'] + ')',
                                    a['analyst_title_ko'], a['vendor_category'], a['analyst_public_sector_adaptation'], status]) + ' |')
    md += ['', '## 현재 홈페이지의 별도 Coworker 템플릿', '',
           '아래 8개는 기존 일본어 앱 100개와 별도 공개된 템플릿이다. 중복 가능성이 있어 합산해 서로 다른 108개 제품이라고 부르지 않는다. [공식 홈페이지](' + BASE + '/)', '',
           '| 공식 이름 | 확인한 용도 요약 | 공공기관 적용 제안 |', '|---|---|---|']
    md += ['| ' + n + ' | ' + s + ' | ' + adapt + ' |' for n, ko, s, adapt in templates]
    md += ['', '## 상세 확인을 우선한 자동화 유형', '',
           '- 근거 업무: 문서 Q&A(062), FAQ 회신(046), FAQ 생성(106), FAQ 정비(095), 내부 자료 Deep Research(109).',
           '- 문서 업무: 기안(006), RFP(103), 계약 비교(003), 회의록(001), 다수 보고 요약(027), 문서 적합성(092).',
           '- 표·계산 업무: 설문 분석(073), 청구·입금 대조(057), 업무 관리표(085).',
           '- 이 분류는 공통 도구를 조합할 후보이며, 앱마다 별도 엔진을 개발해야 한다는 뜻은 아니다.', '',
           '## 해석 주의', '',
           '- 일본 법률·세금 앱의 법령과 판단 기준은 국내에 그대로 적용할 수 없다.',
           '- 채용·인사 앱은 문서·증빙·표현 보조로 검토하며 자동 선발·인사 결정으로 확대하지 않는다.',
           '- PPT VBA 앱과 현재 PPTX 생성 템플릿은 다른 공개 항목이다. 실제 파일 생성 방식·현재 지원 모델은 별도 확인한다.',
           '- 공개 앱 설명에 파일 포맷이 없으면 HWPX·XLSX 지원이라고 추정하지 않는다.', '']
    (ROOT / 'APP_CATALOG.md').write_text('\n'.join(md), encoding='utf-8')
    (evidence / 'index.json').write_text(json.dumps({'url': INDEX, 'sha256': hashlib.sha256(raw).hexdigest(),
                                                   'retrieved_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                                                   'app_count': len(apps), 'categories': dict(counts)}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'app_count': len(apps), 'detail_ok': sum(a['detail_fetch_status'] == 'ok' for a in apps),
                      'detail_unavailable': [a['vendor_app_id'] for a in apps if a['detail_fetch_status'] != 'ok'],
                      'categories': dict(counts), 'output': str(ROOT)}, ensure_ascii=False))

if __name__ == '__main__': main()
