import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { presetCapabilities } from '@/lib/install-presets';

describe('기본 비서 설치', () => {
  it('사진 읽기를 켜고 커넥터는 공공데이터 능력으로', () => {
    expect(presetCapabilities({ connectors: ['law'] } as never)).toEqual({
      image: {},
      public_data: { connectors: ['law'] },
    });
    expect(presetCapabilities({} as never)).toEqual({ image: {} });
  });

  it('옛 칸을 직접 쓰지 않는다', () => {
    // 0027에서 사라지는 칸이다. 지금 쓰면 그때 설치가 멈춘다.
    const src = readFileSync('src/lib/install-presets.ts', 'utf8');
    expect(src).not.toContain('enabled_connectors');
    expect(src).not.toContain('is_personal');
  });

  it('--update는 save_agent로 판을 남긴다', () => {
    const src = readFileSync('src/lib/install-presets.ts', 'utf8');
    expect(src).toContain("'preset_update'");
  });
});
