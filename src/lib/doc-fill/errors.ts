/** 양식을 읽거나 채우지 못한 이유. 문구는 사용자에게 그대로 간다. */
export class DocFillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocFillError';
  }
}
