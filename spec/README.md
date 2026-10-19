# Spec 目录 · 契约与规范

本目录是出生包系统的**契约**。任何一端的实现变更必须同步这里。

## 文件

| 文件 | 说明 |
|---|---|
| `spec.schema.json` | Digital Human Spec v1 定稿：完整 spec、persona、logEntry 的 JSON Schema |
| 本 README | canonical 契约与跨语言约定 |

## 出生包 canonical 契约（验签核心）

签名与验签都基于 canonical 序列化，**两端实现必须字节级一致**：

1. 字段顺序固定：`format, version, application_id, created_at, selections, constitution, assets, platform_public_key`（不含 signature）。
2. JSON 编码规则：
   - PHP：`json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)`
   - TS：`JSON.stringify(obj)`（默认即不转义非 ASCII 与斜杠，与 PHP 上述标志等价）
3. **空对象归一化**：空数组/空对象一律序列化为 `{}`。
   - 原因：PHP `json_decode(..., true)` 会把 `{}` 失真为 `[]`；TS `JSON.parse` 无此问题。
   - 规则：两端 canonical 实现中，值为空数组时替换为 `{}` 再编码。
4. 签名算法：ed25519（PHP libsodium `sodium_crypto_sign_detached`；TS 对应实现），对 canonical 字节签名，base64 存 `signature` 字段。
5. 嵌套对象（selections/constitution）的键顺序以文件内顺序为准（注意：MySQL JSON 列会按键长+字母序重排键，读取 DB 后再编码的顺序可能与入库时不同——canonical 只认"签名那一刻的字节"）。

## 已有实现

- TS（本仓库）：`core/src/package/birth.ts` —— canonical / sign / verify，单元测试与其对齐
- PHP 端实现不在本仓库，canonical 输出需与本契约一致
