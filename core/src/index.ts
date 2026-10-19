export { MemoryLog, type IdentitySet, type ReplayResult } from './log/chain.js';
export { hlcNow, hlcCompare, type HLC } from './log/hlc.js';
export { canonical, entryHash, generateKeyPair, signEntry, verifyEntry, type KeyPair } from './log/signature.js';
export { EVENT_TYPES, type EventType, type Author, type LogEntry } from './log/types.js';
// 多端同步：HLC 全序归并 + 收敛重写（重排重签名收敛为单链）
export { mergeByHlc, rewriteChain, type MergeConflict } from './log/merge.js';
export { validateSpecObject, validateLogEntryObject, type ValidationResult } from './spec/validate.js';
export { canonicalBirthPackage, verifyBirthPackage, type BirthPackage } from './package/birth.js';
