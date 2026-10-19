// token 估算与截断（零依赖启发式：中文≈1.5 字符/token、英文≈4 字符/token 折中）。
// TODO(spec)：接入真实 tokenizer（移动端 bundle 限制，暂用启发式）。
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** 截断到 maxTokens（按启发式）并返回 { text, truncated } */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const maxChars = maxTokens * 3;
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}
