# Recording and Speech Recognition

本文记录当前 Record 录音与本地语音识别实现中的 owner、资源生命周期和排障边界。产品范围与验收以对应 PRD 为准；本文只描述已经落入代码的 current state。

## Owner 与进程边界

- `RecordingManager` 拥有 App-global 唯一采集槽、设备流、Ogg Opus 归档、pause/stop/recovery 和录音期 wake lock。Renderer 与托盘只消费其 snapshot。
- `SpeechRecognitionManager` 拥有 durable speech job、FIFO、Worker generation、重试/取消/退出收敛，以及向 `RecordStore` 发布 transcript / diarization projection 的授权。
- `SpeechModelPackManager` 是 `SpeechRecognitionManager` 内的模型权重子 owner：只管理显式安装、校验、active revision 和移除，不拥有 job terminal 或 Record 内容。
- `LocalInferenceRuntimeRegistry` 只解析 App bundle 中经过 manifest 校验的共享 `onnx-cpu` identity；`LocalComputeCoordinator` 只授予重型推理 lease。
- `myagents-media-worker` 是单 workload、单 generation 的受管子进程。它不监听端口、不下载资源、不读配置，也不直接写 Record 或公开 artifact。

Renderer → Tauri 的普通命令属于控制面。Worker 使用私有 stdin/stdout framed protocol；live PCM 是有界 binary frame，控制与结果是有界 JSON frame。Worker 路径、模型路径和 transcript 不进入 Debug / unified log。

## 依赖复用边界

算法、codec 和通用格式能力优先复用成熟依赖；本模块只保留 MyAgents-specific owner、授权、生命周期、固定内部 profile 和依赖无法表达的 hard limit。2026-08-25 的 live PCM 前审计形成以下约束：

- archive 已用固定版本 `rubato 0.16.2` 替换手写线性重采样器。适配层只负责 interleaved/planar 转换、尾部 duration 对齐与 buffer hard limit；capture callback 不执行 DSP，live analysis 不再建立第二套重采样算法；
- `ogg 0.9.2` 继续用于归档 mux/test，Opus 编解码继续使用 bundled libopus。media Worker 的 reader 只接受 MyAgents 自有单 logical stream、20 ms packet 固定 profile；之所以保留最小 parser，是因为通用 `PacketReader` 会在调用方取得 packet 前完成跨页重组，无法在分配前执行 4,000-byte packet 上限，也不暴露本文需要的连续 page sequence/fail-closed 契约；
- diarization 的模型推理和单窗口能力属于 sherpa-onnx。自有代码只负责 8 小时输入所需的有界窗口、跨窗口 global identity、重叠裁决、确定性稀疏 fallback 与敏感 embedding 清理；不引入通用 clustering 框架或扩张为 ML toolkit；
- transcript revisions 与 recording lifecycle 共享内部 `DurableRecordJournal`：统一 regular-file 检查、identity/schema、sequence/checksum、单行上限、durable append 和 torn-tail repair；领域模块只保留事件类型与投影。

引入或保留底层 primitive 时，必须在 PRD 执行台账记录候选依赖、许可证/target、关键契约与可复现能力缺口；没有缺口就使用依赖，不保留双实现或 feature flag。

## Durable speech job

job metadata 位于：

```text
<app-data>/speech-recognition/jobs/<jobId>/job.json
<app-data>/speech-recognition/private/<jobId>/...
```

Record backfill / diarization 在 App 重启后保留原 job ID，清除旧 Worker generation 并按持久顺序重排；Agent job 在进程边界收敛为 `interrupted`。每个 job 的 `pipeline` 在 admission 时冻结 provider、model-pack revision 与 ONNX Runtime revision。队列执行必须按该 snapshot 解析资源，active pack 的后续变化只影响新 job。

Worker 结果只有同时满足 exact `(jobId, generation)`、协议 shape、业务数量/时间轴上限且当前 generation 仍持有 publish authority 时才能提交。Record ASR 成功后由同一 Manager 排队 diarization；stale generation、cancelled generation 和失败 probe 都不能发布内容。

## 用户模型包

当前 pack identity 固定为 `local-standard-speech / sensevoice-2024-07-17-v1`。编译期 source lock 位于 `src-tauri/media-worker/model-pack-source-lock.json`，固定：

- 四项上游下载 asset 与各自 URL、revision、size、SHA-256、格式和许可；
- 五个实际推理文件的 archive source path、安装相对路径、size 与 SHA-256；
- 五份 legal artifact 的 remote/archive 来源；
- 总下载预算和 300 MiB 硬上限；
- App updater 同一 Minisign trust root 与 detached signature 要求。

远端发布面固定为：

```text
https://download.myagents.io/models/speech/sets/<pack-revision>/manifest-v1.json
https://download.myagents.io/models/speech/sets/<pack-revision>/manifest-v1.json.sig
```

远端 manifest bytes 必须与 App/Worker 编译内 source lock 完全一致，签名才会被接受。远端 JSON 不能提供新的本地路径、host、模型或 native library。

持久布局：

```text
<app-data>/speech-recognition/models/
  active.json
  packs/pack-<activation-uuid>/
    manifest.json
    models/...
    legal/...
  private/.download-<operation-uuid>/
  private/.staging-<operation-uuid>/
```

`active.json` 是小型原子指针，不使用 symlink；它保存 schema、pack revision、exact directory name、manifest hash、原始 manifest signature 和 activation time。pack 目录名只接受 `pack-` 加 32 位 UUID hex。

## 安装与激活顺序

1. 用户显式调用 install；同一时刻只允许一个 install/remove operation。
2. 校验随 App 发布的 media Worker、native manifest 与共享 ORT 都是普通文件。
3. 从固定第一方地址取得 manifest/signature，验证 byte identity 与 updater Minisign trust root。
4. 顺序下载锁定 asset 到 0700 private 目录中的 0600 `create_new` 文件；每个响应限制为 HTTPS GitHub 固定 host 集，逐 chunk 执行 exact size、SHA-256 与总下载硬上限。
5. Rust 内置的 pure-Rust bzip2 decoder + tar reader 只选择 source lock 白名单文件。archive 中任意 traversal、重复路径、symlink 或 special entry 都让整个 staging 失败；运行时不调用系统 tar、Python 或用户 PATH。
6. manifest 最后写入；Worker/Manager 都要求 manifest byte-identical，并逐项重开模型与 legal 文件校验 regular file、无执行位、size 和 SHA-256。
7. 取得 `SpeechModelValidation` compute lease，让当前随包 Worker 依次真实创建并释放 ASR、VAD 和 diarizer engine。高优先级 workload 到达时 kill exact probe tree、释放 lease 后重试。
8. staging 以 no-replace directory rename 发布到唯一 pack 目录，最后 atomic replace `active.json`。rename 前明确失败会删除新 pack并保持旧 pointer；rename 已可见但 parent-directory sync 失败时绝不删除 pointer 已引用的 pack，状态保留新 active 并报告 `SPEECH_RESOURCE_ACTIVATION_DURABILITY_UNCONFIRMED`。

安装成功只改变 capability；不会扫描历史 Record，也不会自动创建 backfill job。历史音频必须由用户点击“开始转录”后才进入 admission。

## 移除、恢复与安全

- 任何非终态 speech job、active job 或 retained Worker 存在时，remove 返回 `SPEECH_RESOURCE_BUSY`。
- remove 先撤销 exact `active.json`，再只枚举并删除严格 `pack-<uuid>` 命名的普通目录/链接；未知文件或目录保留。即使 active pointer 已损坏，用户仍可安全移除已识别的 App-owned pack。
- 启动清理只处理 `models/private/` 直系、普通目录且以 `.download-` / `.staging-` 开头的 abandoned operation；不按扩展名或递归扫描其它根。
- pack 缺失、签名/manifest/file 漂移或 execute bit 出现都 fail closed；不会回退系统模型、在线 ASR、用户 cache 或第二份 ONNX Runtime。
- App shutdown 先取消资源 operation 并终止 retained probe process tree，再撤销 speech job 的 publish authority并收敛其 Worker。

## 状态与错误

Tauri 提供 `cmd_speech_model_pack_status/install/remove`。状态为 `not_installed | installing | removing | ready`，另带 `usable`、active/available revision、公开资源字节数与结构化 `lastErrorCode`。主要错误族：

- `SPEECH_NATIVE_RUNTIME_UNAVAILABLE`：随包 Worker/native/shared ORT 不完整；
- `SPEECH_RESOURCE_NETWORK`：固定网络路径不可用或跳转 host 不允许；
- `SPEECH_RESOURCE_MANIFEST_INVALID` / `SPEECH_RESOURCE_SIGNATURE_INVALID`：发布 manifest 或签名不可信；
- `SPEECH_RESOURCE_DOWNLOAD_INVALID` / `SPEECH_RESOURCE_ARCHIVE_INVALID` / `SPEECH_RESOURCE_PACK_INVALID`：下载、archive 或安装 inventory 漂移；
- `SPEECH_MODEL_LOAD_FAILED` / `SPEECH_MODEL_LOAD_TIMEOUT`：真实最小加载未通过；
- `SPEECH_RESOURCE_BUSY`：并发 mutation 或仍有 workload 引用资源；
- `SPEECH_RESOURCE_CORRUPT`：active pointer / pack 的持久校验失败。

日志只记录 operation、revision、公开资源 bytes、generation、阶段与结构化错误码；不得记录用户音频、transcript、完整路径或远端原始错误正文。
