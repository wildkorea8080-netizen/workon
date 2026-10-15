import { describe, it, expect } from 'vitest';
import { formatFileSize } from '@/lib/file-size';

describe('파일 크기 표시', () => {
  it('KB는 반올림, 1KB 미만도 1KB, MB는 소수 한 자리', () => {
    expect(formatFileSize(10)).toBe('1KB');
    expect(formatFileSize(15_360)).toBe('15KB');
    expect(formatFileSize(2_621_440)).toBe('2.5MB');
  });
});
