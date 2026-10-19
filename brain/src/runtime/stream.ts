// 真流式的地基：把响应体按块解码成文本片段。
//
// 为什么要单独一个文件：**两处都要用它**——
//   · runtime 的 `net.fetch`（适配器通过它拿流）；
//   · 适配器**默认**的那条 fetch（没注入 http 时走它）。
// 一处实现两处用，两条路才有统一的真流式行为（别只改一处：注入的那条流式、默认那条整包）。
export async function* decodeBody(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) yield dec.decode(value, { stream: true });
    }
    const tail = dec.decode();
    if (tail) yield tail;
  } finally {
    try { reader.releaseLock(); } catch { /* 已经关了就忽略 */ }
  }
}
