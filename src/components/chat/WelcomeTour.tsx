'use client';

import { useState, useEffect } from 'react';

/**
 * 최초 로그인 안내 (P3-4).
 *
 * 웍스AI는 가입 직후 파란 튜토리얼을 띄운다. 도입 초기에 "무엇부터 눌러야
 * 하는지 모르겠다"로 이탈하는 것을 막기 위한 것이고, 공공기관은 AI 도구를
 * 처음 쓰는 직원 비중이 높아 더 필요하다.
 *
 * 서버에 상태를 두지 않고 localStorage만 쓴다. 안 본 사람에게 한 번 더 보이는
 * 것은 손해가 없지만, 이걸 위해 users 테이블에 컬럼을 늘리고 마이그레이션을
 * 하나 더 만드는 것은 값이 맞지 않는다.
 */

const STORAGE_KEY = 'workon.tour.seen.v1';

interface Step {
  icon: string;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    icon: '🗂️',
    title: '비서를 골라 시작하세요',
    body:
      '업무별로 준비된 비서가 있습니다. 공문 초안, 보고서, 회의록 정리처럼 하려는 일에 맞는 비서를 고르면 그 일에 맞게 답합니다. 카테고리 탭으로 찾고, 자주 쓰는 것은 별표를 눌러 두세요.',
  },
  {
    icon: '📎',
    title: '기관 자료를 근거로 답합니다',
    body:
      '관리자가 올려 둔 규정·지침을 참고해 답하고, 참고한 문서는 답변 아래 출처로 보여줍니다. 출처가 없는 답변은 기관 자료가 아니라 일반 지식이라는 뜻이니 그대로 쓰지 마세요.',
  },
  {
    icon: '🤖',
    title: '나만의 비서도 만들 수 있어요',
    body:
      '자주 하는 일이 있으면 직접 비서를 만들어 두세요. 하는 일을 한두 줄 적으면 프롬프트를 다듬어 주고, 참고할 파일도 붙일 수 있습니다. 쓸 만하면 공식 비서로 등록 신청할 수 있습니다.',
  },
  {
    icon: '⚠️',
    title: '결과는 반드시 확인하세요',
    body:
      'AI는 사실과 다른 내용을 그럴듯하게 쓸 수 있습니다. 숫자·기한·법령 조항은 원문과 담당자를 통해 확인한 뒤 사용하세요. 결재 문서에 그대로 올리면 안 됩니다.',
  },
];

export default function WelcomeTour() {
  const [step, setStep] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // 서버 렌더링 중에는 localStorage가 없다. 마운트 후에 판단한다.
    try {
      if (!localStorage.getItem(STORAGE_KEY)) setOpen(true);
    } catch {
      // 시크릿 모드 등으로 막혀 있으면 그냥 띄우지 않는다
    }
  }, []);

  const close = () => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {
      // 저장하지 못해도 이번 화면은 닫는다
    }
    setOpen(false);
  };

  if (!open) return null;

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-6 pt-7 pb-6 text-center">
          <div className="w-14 h-14 mx-auto mb-4 flex items-center justify-center rounded-2xl bg-blue-50 text-3xl">
            {current.icon}
          </div>
          <h2 className="text-lg font-bold text-slate-900">{current.title}</h2>
          <p className="mt-2 text-sm text-slate-600 leading-relaxed">{current.body}</p>
        </div>

        <div className="px-6 pb-6">
          <div className="flex items-center justify-center gap-1.5 mb-5">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={`h-1.5 rounded-full transition-all ${
                  i === step ? 'w-5 bg-[#003087]' : 'w-1.5 bg-slate-200'
                }`}
              />
            ))}
          </div>

          <div className="flex gap-2">
            <button
              onClick={close}
              className="px-4 py-2.5 text-sm text-slate-500 hover:text-slate-700"
            >
              건너뛰기
            </button>
            <div className="flex-1" />
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50"
              >
                이전
              </button>
            )}
            <button
              onClick={() => (isLast ? close() : setStep((s) => s + 1))}
              className="px-5 py-2.5 bg-[#003087] hover:bg-[#002070] text-white text-sm font-semibold rounded-xl"
            >
              {isLast ? '시작하기' : '다음'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
