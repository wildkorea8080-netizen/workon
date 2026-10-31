import { readdirSync } from 'fs';
import { join } from 'path';

/** Windows와 Unix에서 동일한 소스 파일을 검사한다. 경로는 비교용으로 /로 정규화한다. */
export function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(path.replace(/\\/g, '/'));
  }
  return files.sort();
}
