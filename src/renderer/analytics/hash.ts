/**
 * Analytics Privacy Hashing
 *
 * 用户自定义名（Agent 名、Workspace 名等）默认不上报明文——它们可能含 PII
 * （"homework_helper_for_my_son" / "工作记账" / "妻子生日 todo" 等）。如果
 * 分析端确实需要"用户用了多少个不同 Agent"这类聚合指标，调用方应传 `agent_hash`，
 * 不是 raw name。
 *
 * 算法：SHA-256(`${pepper}:${name}`) → 截前 16 字节 → 32 字符 hex。
 *
 * 关键安全设计：**pepper 是本机随机生成的 UUID，永不上传**。
 * 之前的版本错用 `device_id` 作 salt——但 device_id 是每个事件都会附带上传的
 * 字段（见 tracker.ts），分析端拿到后可以为任意候选名重算 hash 反查（低熵名
 * 字如 "test" / "mino" 可字典攻击）。pepper 隔离了这层风险：分析端拿不到 salt，
 * 反查不可行。
 *
 * 副作用：跨设备的同名 agent 哈希值不同，所以无法跨设备聚合 unique count。
 * 这是 trade-off，符合 PRD §4.6 "保护用户隐私" 的目标——本来跨设备聚合也不
 * 是声明的目标。
 *
 * 同步 fallback：sync 版本走缓存——首次访问返回 null 并后台计算，
 * 第二次起返回 hash。对埋点是可接受的（少量首次事件 agent_hash 缺失，
 * 不影响整体聚合）。预热路径：App.tsx 在 config.agents 加载后批量调
 * hashAgentName 预填缓存。
 *
 * 缓存采用 bounded LRU（上限 1000）。命中时 delete+set 把条目移到末尾刷新
 * 顺序；满时驱逐最早条目。1000 个不同 Agent 远超实际产品场景，但避免极端
 * 用户/恶意场景内存泄漏。
 */

const PEPPER_KEY = 'myagents_analytics_pepper';
const MAX_CACHE_SIZE = 1000;

let cachedPepper: string | null = null;
const cache = new Map<string, string>();
const pending = new Set<string>();

/**
 * 取 / 生成本机 pepper（永不上传）。
 * Tauri WebView 提供 localStorage；测试 / SSR 环境的 catch 兜底用一次性随机值。
 */
function getOrCreatePepper(): string {
  if (cachedPepper) return cachedPepper;
  try {
    let p =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(PEPPER_KEY)
        : null;
    if (!p) {
      p = crypto.randomUUID();
      try {
        if (typeof localStorage !== 'undefined')
          localStorage.setItem(PEPPER_KEY, p);
      } catch {
        // ignore — non-persistent pepper still works for this session
      }
    }
    cachedPepper = p;
  } catch {
    cachedPepper = `ephemeral-${crypto.randomUUID()}`;
  }
  return cachedPepper;
}

/**
 * Async：SHA-256(pepper + name) → 前 16 字节 hex
 */
export async function hashAgentName(
  name: string | null | undefined,
): Promise<string | null> {
  if (!name) return null;
  const cached = cache.get(name);
  if (cached !== undefined) {
    // Touch on hit so Map iteration order reflects true recency (LRU, not FIFO).
    // Cheap — Map.delete + set is O(1) and the cache caps at 1000 entries.
    cache.delete(name);
    cache.set(name, cached);
    return cached;
  }

  try {
    const pepper = getOrCreatePepper();
    const text = `${pepper}:${name}`;
    const buf = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const hex = Array.from(new Uint8Array(digest))
      .slice(0, 16)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Bounded LRU — evict least-recently-used when at capacity. Map iteration
    // is insertion order, and we re-insert on hit above, so the first key is
    // the LRU victim.
    if (cache.size >= MAX_CACHE_SIZE) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(name, hex);
    return hex;
  } catch (e) {
    console.warn('[Analytics] hashAgentName failed:', e);
    return null;
  }
}

/**
 * Sync：从缓存读，没命中触发后台异步计算并返回 null
 *
 * 适用于 track() call site——埋点不能 await。首次返回 null 是预期行为，
 * 分析端将其视为 "首次出现该 agent" 的尾部。预热通过 App.tsx 的 useEffect
 * 在 config.agents 加载后批量调 hashAgentName 完成。
 */
export function hashAgentNameSync(
  name: string | null | undefined,
): string | null {
  if (!name) return null;
  const cached = cache.get(name);
  if (cached !== undefined) {
    cache.delete(name);
    cache.set(name, cached);
    return cached;
  }

  if (!pending.has(name)) {
    pending.add(name);
    void hashAgentName(name).finally(() => {
      pending.delete(name);
    });
  }
  return null;
}

export type PrivateIdentityDomain = 'record' | 'speech-job';

/**
 * Domain-separated identity hashing for product analytics. This deliberately
 * reuses the established local pepper, SHA-256 implementation, and bounded
 * cache instead of introducing a second privacy-identity owner.
 */
export function hashPrivateIdentity(
  domain: PrivateIdentityDomain,
  identity: string | null | undefined,
): Promise<string | null> {
  return hashAgentName(identity ? `${domain}:${identity}` : identity);
}

export function hashPrivateIdentitySync(
  domain: PrivateIdentityDomain,
  identity: string | null | undefined,
): string | null {
  return hashAgentNameSync(identity ? `${domain}:${identity}` : identity);
}

/**
 * 测试用：清空缓存
 */
export function _clearHashCacheForTesting(): void {
  cache.clear();
  pending.clear();
  cachedPepper = null;
}
