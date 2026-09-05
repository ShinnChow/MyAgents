# React 状态与 Effect 稳定性

本文记录 Renderer 中会影响副作用正确性和大型列表性能的稳定性约束。React API 的一般用法不在这里复述；具体依赖项以 lint、组件 owner 和测试为准。

## 先判断语义，不按类型删依赖

Effect dependency 表示“哪些值变化时需要重新同步外部系统”。不要因为某个值是 object、hook 返回值或 callback 就机械地加入或删除：

- effect 确实响应其变化：稳定上游引用，或把必要字段拆成 primitive dependency；
- effect 只需调用最新版 callback、但不应因 callback identity 重启：使用 latest ref / effect event 模式；
- 同一动作由用户事件触发：放在 event handler，不要借 effect 间接触发；
- 可以在 render 中纯计算：不要建立 derived state effect。

不得用空依赖数组掩盖会改变资源 identity 的值。也不得通过 eslint suppress 绕过不清楚的 lifecycle。

## Context owner

Context Provider 的 value 应按语义拆分并稳定化：

- data 与 actions 变化频率差异大时使用 dual context；
- action 使用 `useCallback` 或稳定 dispatcher；
- value 用 `useMemo`，依赖必须包含真正决定 value 的字段；
- 频繁数据变化不能迫使只消费 action 的组件重渲染。

`ConfigProvider` 的 data/actions separation 是当前参考实现。稳定引用是性能与 effect correctness 的契约，不只是 micro-optimization。

## Latest ref 模式

当长期存活的 callback、listener、timer 或 async completion 需要读取最新 state，但其订阅 identity 不应随 state 重建时：

```ts
const valueRef = useRef(value);
valueRef.current = value;

const stableHandler = useCallback(() => {
  consume(valueRef.current);
}, []);
```

约束：

1. ref 必须在每次 render 同步，不能只在 effect 中延迟更新；
2. stable callback 只能依赖 ref 或其它稳定 owner；
3. 若 callback 本身是对外 observable prop，自定义 memo comparator 跳过它之前必须证明其 identity 稳定；
4. ref 解决 stale closure，不改变 state owner，也不能用来绕过正常重渲染。

## 异步 lifecycle

组件启动异步工作时优先使用 AbortSignal、generation token 或现有 service 的取消能力。只有 API 无法取消时才用 mounted ref 丢弃 completion：

```ts
const mountedRef = useRef(false);

useEffect(() => {
  mountedRef.current = true;
  return () => {
    mountedRef.current = false;
  };
}, []);
```

setup 必须每次显式恢复 `true`。即使生产入口暂未包 `StrictMode`，组件和测试也必须能承受 setup → cleanup → setup；不能依赖“effect 只执行一次”维持资源正确性。

每个 timer、animation frame、DOM listener、Tauri event listener、Observer 和网络订阅都由创建它的 effect cleanup。若注册是 async 的，使用现有 abort-aware helper，避免 cleanup 发生后晚到的注册逃逸。

## 列表与 memo

大型会话、Tab 或树列表需要避免无关 item 重渲染时：

- state transition 保留未变化 item 的对象 identity；
- 子组件只接收自己的 data 和必要状态；
- callback prop 先稳定，再决定是否使用 `memo`；
- 自定义 comparator 只比较能完整决定渲染输出的 props，不能为了命中 memo 忽略不稳定或可见字段。

Tab workspace 的 transition 必须经过 `useTabWorkspaceController`；不要直接 setter 破坏 identity-preserving update。优化前后用 React profiler 或有针对性的 render-count test 证明收益，避免为轻量组件增加 comparator 复杂度。

## 外部状态同步

Effect 与 API、文件、Sidecar 或 Tauri command 交互时：

1. 明确 authority 和 generation；旧请求 completion 不得覆盖新选择；
2. loading/error/data 应作为同一状态机提交，不能由多个 effect 互相修补；
3. dependency 变化后的 cleanup 要使上一代结果失效；
4. 不在 state updater 中执行 IO、广播或其它副作用；updater 必须保持纯函数；
5. render phase 不读写外部可变状态。

## 验证

涉及稳定性修改时，按风险覆盖：

- dependency 改变、快速切换与 late completion；
- mount/unmount/remount，必要时在测试中包 `StrictMode`；
- listener/timer/Observer 没有重复注册或 cleanup 泄漏；
- memoized child 只在决定输出的 props 变化时更新；
- state updater 可重复调用且无副作用；
- Tab/Session 切换不会让旧 generation 的数据写入新 owner。
