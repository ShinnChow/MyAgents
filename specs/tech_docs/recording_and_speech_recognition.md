# Recording and Speech Recognition

本文记录当前 Record 录音与本地语音识别实现中的 owner、资源生命周期和排障边界。产品范围与验收以对应 PRD 为准；本文只描述已经落入代码的 current state。

## Owner 与进程边界

- `RecordStore` 是 `~/.myagents/records/` 下 text/audio Record、artifact、timeline、transcript revision、diarization projection、speaker override 与 export source 的持久权威。旧 `thoughts/` 只作为幂等迁移输入；迁移完成后产品不再双写。
- `RecordingManager` 拥有 App-global 唯一采集槽、设备流、Ogg Opus 归档、pause/stop/recovery 和录音期 wake lock。Renderer 与托盘只消费其 snapshot。
- `SpeechRecognitionManager` 拥有 durable speech job、FIFO、Worker generation、重试/取消/退出收敛，以及向 `RecordStore` 发布 transcript / diarization projection 的授权。
- `SpeechModelPackManager` 是 `SpeechRecognitionManager` 内的模型权重子 owner：只管理显式安装、校验、active revision 和移除，不拥有 job terminal 或 Record 内容。
- `LocalInferenceRuntimeRegistry` 只解析 App bundle 中经过 manifest 校验的共享 `onnx-cpu` identity；`LocalComputeCoordinator` 只授予重型推理 lease。
- `myagents-media-worker` 是单 workload、单 generation 的受管子进程。它不监听端口、不下载资源、不读配置，也不直接写 Record 或公开 artifact。

Renderer → Tauri 的普通命令属于控制面。Worker 使用私有 stdin/stdout framed protocol；live PCM 是有界 binary frame，控制与结果是有界 JSON frame。Worker 路径、模型路径和 transcript 不进入 Debug / unified log。

## 产品控制面与投影

- Launcher 的 Chat/Record mode 共用输入主区域；text/audio Record 进入同一个任务中心列表。文字创建仍写 `RecordStore`，开始录音必须先取得 `RecordingManager` 唯一采集槽。
- audio Record detail 是单实例顶部 Tab。同一 `recordId` 只聚焦，不重复打开；持久 Tab snapshot 只保存 `id/view/recordId/title`，恢复前用 `RecordStore.get` 验证。Record 不存在时同一 Tab 退回 Record 列表；Tab 不拥有 Session/Sidecar，也不持久化录音 snapshot、播放 seek 或电平。
- active recording 的 pause/resume/stop、笔记与 Mark 都在详情页完成。待提交笔记在关闭 Tab、退出 App、安装更新重启前必须先 flush；失败则阻止该关闭动作，不能把输入框当持久 authority。
- capture fatal event 由同一个 `RecordingManager` operation gate 先关闭 archive/analysis admission、停止旧 session 并冻结媒体时钟，再 durable commit `DeviceGap`；gap 提交失败时不重开设备。随后以固定五次、500 ms 间隔重开 admission 时冻结的 exact `CapturePlan`。live boundary 建立失败只关闭后续实时 analysis，永久 Ogg archive 继续并在 stop 后走既有 backfill 收敛，不能跨 gap 拼接 VAD 状态。成功后沿同一 Record/generation 继续并在 lifecycle 记录 recovery；耗尽后走现有 `interrupted` safe settlement。恢复不会重新 preflight 当前默认设备、热接管不同 identity/格式，也不建立第二个设备 watcher。Renderer 的录音计时、笔记和 Mark 锚点只消费 Manager `mediaDurationMs`，不得用墙钟绕过 pause/recovery freeze。极端 settlement worker/manifest 失败时必须释放 exact generation 的内存槽，保留 durable `stopping/finalizing` 供既有启动恢复处理。
- 录音接纳后由 `RecordingManager` 独立持有 wake lock；获取失败不阻止录音，但 snapshot 与 lifecycle 保留 `RECORDING_WAKE_LOCK_UNAVAILABLE`，Record Detail 显示非阻塞警告。它只防止 idle sleep，不承诺合盖、用户主动睡眠、OS 强制休眠或断电期间继续采集。
- 没有 transcript 的历史音频在转录区域显示“开始转录”。只有用户点击后才调用 `cmd_speech_record_transcribe`；安装模型、打开详情或启动 App 都不会自动扫描历史 Record。
- 本期人工纠错只覆盖 speaker rename、merge 与 exact segment reassign。原始 transcript revision 保留，override 单独持久化并在 projection/export/search 时合成；不提供任意字词改写。
- 托盘只消费 `RecordingManager` projection：录音中 icon 增加状态圆点，菜单出现“正在录音...”，点击打开 exact Record Tab。托盘不拥有录音状态或导航 history。
- SearchEngine 复用现有 Tantivy + jieba 建立 Record index；`RecordStore` change broadcast 驱动 upsert/delete，搜索按 `record_id` 合并 title/content/tag/transcript/speaker 命中，每个 Record 最多返回一项。
- analytics 复用 renderer `track()` 与现有 Tauri bridge，只记录 typed milestone、枚举、duration bucket 与不可逆 Record hash；不记录音频、transcript、speaker name、路径或自由文本，也不新建 endpoint/outbox/retry/store。

## 依赖复用边界

算法、codec 和通用格式能力优先复用成熟依赖；本模块只保留 MyAgents-specific owner、授权、生命周期、固定内部 profile 和依赖无法表达的 hard limit。2026-08-25 的 live PCM 前审计形成以下约束：

- archive 已用固定版本 `rubato 0.16.2` 替换手写线性重采样器。适配层只负责 interleaved/planar 转换、尾部 duration 对齐与 buffer hard limit；capture callback 不执行 DSP，live analysis 不再建立第二套重采样算法；
- attachment container/codec probe 与解码固定使用 crates.io `symphonia =0.6.1` 及 Cargo.lock checksum，不再依赖同版本 Git release commit；features 仍只打开产品白名单需要的 AAC/ADPCM/AIFF/ALAC/FLAC/ISO-MP4/MP3/Ogg/PCM/Vorbis/WAV，不引入 FFmpeg 或第二个 decoder；
- `ogg 0.9.2` 继续用于归档 mux/test，Opus 编解码继续使用 bundled libopus。media Worker 的 reader 只接受 MyAgents 自有单 logical stream、20 ms packet 固定 profile；之所以保留最小 parser，是因为通用 `PacketReader` 会在调用方取得 packet 前完成跨页重组，无法在分配前执行 4,000-byte packet 上限，也不暴露本文需要的连续 page sequence/fail-closed 契约；
- diarization 的模型推理和单窗口能力属于 sherpa-onnx。自有代码只负责 8 小时输入所需的有界窗口、跨窗口 global identity、重叠裁决、确定性稀疏 fallback 与敏感 embedding 清理；不引入通用 clustering 框架或扩张为 ML toolkit；
- transcript revisions 与 recording lifecycle 共享内部 `DurableRecordJournal`：统一 regular-file 检查、identity/schema、sequence/checksum、单行上限、durable append 和 torn-tail repair；领域模块只保留事件类型与投影。

引入或保留底层 primitive 时，必须在 PRD 执行台账记录候选依赖、许可证/target、关键契约与可复现能力缺口；没有缺口就使用依赖，不保留双实现或 feature flag。

2026-08-26 稳定版复核没有机械追新：Rubato `5.0.0` 要求 Rust `1.87`，而主 App 仍声明 `rust-version = 1.81`；其 5.0 修复的动态 ratio ramp 路径也不被上述固定 ratio adapter 使用。因此当前继续锁定 `0.16.2`，避免为不相关修复抬高整个 App MSRV并迁移两份 adapter。该结论不妨碍以后在项目统一提高 MSRV或确实需要动态 ratio 时重新评估。

## 版本化质量基准

模型质量 release pool 使用 `scripts/speech-quality-corpus-source-lock.json` 作为 corpus source of truth。它固定 AISHELL-1 普通话近讲、AISHELL-4 普通话远场会议、ASCEND 中英混说和 AMI 英文会议的 upstream revision、URL、bytes、SHA-256、许可证、选样窗口与完整 prepared manifest SHA-256；runner 不接受 prepared manifest 自行声明来源。cache/output 在下载前按物理路径拒绝仓库内目录及 symlink/junction escape，原始语料和带正文的 prepared manifest 不进入 App bundle、Git、日志或遥测。

准备入口 `scripts/prepare-speech-quality-corpus.mjs` 继续复用 native resource 的 `acquireLockedResource` 内容寻址下载与离线 cache，不实现第二套 downloader。PyArrow `21.0.0`（Apache-2.0）、Praatio `6.2.0`（MIT）、JiWER、MeetEval 与 WeText 均使用 PEP 723 + uv 原生 lock 固定直接、传递包与 artifact hash，`--offline` 同时约束语料和 Python 环境。FFmpeg `8.0.1` 使用 bitexact mux/codec flag 并去除 metadata；任何工具或输出漂移都会因完整 prepared manifest hash 不符而 fail closed，同一锁连续准备必须得到 byte-identical 的 28 个质量音频、3 个 AMI 词级时间标注 live 片段及 manifest。三个 live 片段在最后一个人工标注词后追加 3 秒确定性静音，只为保证测到自然 VAD 出句而非 stop/finalize flush。FFmpeg 只生成测试输入，不随 App 分发，也不改变产品附件解码继续使用 Symphonia、内部 Record 继续使用固定 Ogg Opus profile 的边界。

执行入口 `scripts/speech-quality-benchmark.mjs` 直接复用 `media-worker-batch-client.mjs` 与从原 live smoke 抽出的 `media-worker-live-client.mjs`，驱动同一个正式 Worker/native manifest/共享 ORT/模型 manifest，不建立 benchmark-only 推理路径或新 Worker 协议。live 捕获时钟从 Worker spawn 开始，`ready` 前的已提交 PCM 按产品 spool 语义追赶；Worker 对触发帧完成 VAD accept 后先发 `input_ack`，再同步 ASR 并发 `transcript_segment`，因此 runner 能分别记录最后有效语音采样→VAD 确认、VAD 确认→stable final 和总耗时，并要求目标 final 覆盖该最后有效语音采样、拒绝依赖 terminal flush 的样本。CER/WER 委托 JiWER `4.0.0`，DER 委托 MeetEval `0.4.3`，中文数字、全半角与标点归一化委托 WeText `0.1.6`。为避免长跑期间工作树原子替换造成“报告 hash 与实际执行 bytes 不同”，runner 从已快照 bytes 创建私有执行副本：正式 native bundle 保持原 manifest 相对布局并继续由 Worker 校验全部 hash/signing/legal/exact-path identity，指标脚本与 uv lock 同样成对复制；模型、语料和共享 ORT 不复制，仍由正式 Worker 与逐 case/终态 snapshot 校验。`uv → Python/FFmpeg` 按现有跨平台政策以 POSIX process group 或 Windows `taskkill /T` 有界收敛。报告只保存这些 hash、显式 model-pack revision、环境、计数、耗时、错误分解和 rate，不保存 reference、hypothesis 或 transcript 正文。

2026-08-25 Apple M1、16 GiB、固定 `local-standard-speech / sensevoice-2024-07-17-v1` 最终冻结结果为：普通话近讲 CER `2.53%`、普通话会议 CER `11.96%`、英文会议 WER `25.75%`、两段四人会议按 scored speaker seconds 聚合 DER `22.47%`，8 个中英混说样本为 `0` 个整段漏识别，全部通过 PRD 门槛。同一报告的 Worker ready 为 `1,508.153 ms`；cold 首句最后有效语音→VAD 确认 `2,442.567 ms`、VAD→final `327.078 ms`、总计 `2,769.645 ms`；14 个 warm 样本的最后有效语音→final p50/p95 为 `2,652.264 / 3,049.730 ms`，其中 VAD→final p50/p95 为 `217.078 / 258.411 ms`。15 个片段均覆盖各自最后有效语音采样，并在 stop 前以一个稳定 final 发布，无 partial 和 terminal flush；这些值只作为该固定环境的测量证据，不构成产品 SLA。该报告关闭 7.2 的 ASR/DER 质量与 live final/cold 测量门槛，不替代 2/8 小时 capture/backfill、采集 CPU 或五 target 正式安装包门槛。

2026-08-26 首次发布前将上述同一组模型字节的 pack revision 从 `sensevoice-2024-07-17-v1` 收敛为 `local-standard-speech-v1`；所有 asset URL、size 和 SHA-256 不变，因此已冻结的质量结果仍适用，这项 identity-only rename 不单独重跑质量基准。

2026-08-26 中国大陆三网节点对 GitHub release 的 10 秒 HTTP 可达率只约 `58.5%–62.8%`，因此新的 `local-standard-speech-v2` 将相同的四个 asset 和三个 remote legal source 改由 `download.myagents.io` 的 content-addressed R2 object 供应。模型、license、upstream revision、size/SHA-256 和总预算均不变；已发布的 v1 不覆盖，质量基准不重跑。

## Durable speech job

job metadata 位于：

```text
<app-data>/speech-recognition/jobs/<jobId>/job.json
<app-data>/speech-recognition/private/<jobId>/...
```

Record backfill / diarization 在 App 重启后保留原 job ID，清除旧 Worker generation 并按持久顺序重排；Agent job 在进程边界收敛为 `interrupted`。每个 job 的 `pipeline` 在 admission 时冻结 provider、model-pack revision 与 ONNX Runtime revision。队列执行必须按该 snapshot 解析资源，active pack 的后续变化只影响新 job。

Worker 结果只有同时满足 exact `(jobId, generation)`、协议 shape、业务数量/时间轴上限且当前 generation 仍持有 publish authority 时才能提交。Record ASR 成功后由同一 Manager 排队 diarization；stale generation、cancelled generation 和失败 probe 都不能发布内容。

### Agent attachment job scope

`myagents speech transcribe/status/wait/cancel/list` 是给 AI 使用的 Session-scoped 工具面。CLI 不接受 Session、Workspace 或 Sidecar scope 参数；Node 从当前 `SessionEngine` 和进程环境取得 Sidecar identity，Rust Management API 用 request header 中的 generation 回查同一 live process 的 authoritative `product_session_id + workspace_path`。job admission 自动冻结这两个字段。

输入必须是该 Workspace 内已存在的普通文件，拒绝 URL、symlink、逃逸路径与不受支持格式。默认输出根为 `<workspace>/myagents_files/speech-transcriptions`，发布仍使用 private staging + authenticated owner marker + no-replace rename；partial 结果不可见。status/cancel/list 都按 exact caller Session 过滤，所以其它 Session 即使知道 job ID 也得到 `SPEECH_JOB_NOT_FOUND`。Agent job 的可见历史保留 30 天；App 重启时非终态 Agent job 收敛为 `interrupted`，不会静默继续使用旧 caller generation。

## 录制中转写

资源在录音 admission 时已 ready 才会接纳 live workload；缺资源的录音只做权威 Ogg Opus 归档。模型包后续安装只改变 capability，不扫描或自动排队这些历史 Record。

每个 physical track 的 callback 经一个固定 fan-out 先写 archive ring，再写可选 analysis ring。两个后台 writer 共用 `rubato` adapter；analysis 只落一份固定路径的 16 kHz mono raw PCM16 spool，不自创媒体容器。`SpeechRecognitionManager` 只读取已 `flush + sync_data` 的 committed sample，逐个有界 binary frame 发给 exact-generation Worker，并校验 ACK、heartbeat checkpoint、segment revision 和 terminal metrics。Worker response 使用 bounded reader channel 和 120 秒基础设施超时；超时只重启当前 live generation，不影响 archive。

Pause 先停止两个 ring 的 admission，再暂停设备；analysis writer 排空、刷新 resampler 并 fsync 后，Manager 以每轨 exact sample boundary 发送 `Flush`。Worker 在该边界强制结束 VAD 句段、发布稳定整句并重置 VAD，不写虚假静音，也不把 wall pause 算入媒体时间。Resume 从同一 append-only spool 继续。

live revision 写入 `transcript/revisions.jsonl`，复用 `DurableRecordJournal`。Worker-local ID 不成为产品 identity；RecordStore 按 `track + start + end` 生成稳定 segment ID，同边界重算只递增 revision。generation 失败时从最后 durable segment end 重放，以重建尚未发布的 VAD pending state；每帧 ACK 仍即时校验，但不能仅从最后 ACK 继续，否则会丢掉已 ACK、尚未形成稳定句段的语音。

Stop 先停止并落盘 capture/archive/analysis，再提交永久 Ogg artifact；只有本次录音在开始时已接纳 live workload，才会用最终 analysis boundary 收敛 live Worker，并自动为永久 Ogg 接纳 recording-final backfill。analysis 失败不把可用音频判坏。异常退出恢复只清理 Record 内两个固定 spool 文件；只对 manifest 表明此前已经接纳 live transcription 的 interrupted Record 恢复 backfill，普通历史录音保持手动“开始转录”。

## 用户模型包

当前 pack identity 固定为 `local-standard-speech / local-standard-speech-v2`。编译期 source lock 位于 `src-tauri/media-worker/model-pack-source-lock.json`，固定：

- 四项第一方镜像 asset 与各自 URL、upstream revision、size、SHA-256、格式和许可；
- 五个实际推理文件的 archive source path、安装相对路径、size 与 SHA-256；
- 五份 legal artifact 的 remote/archive 来源；
- 总下载预算和 300 MiB 硬上限；
- App updater 同一 Minisign trust root 与 detached signature 要求。

2026-08-26 对 3D-Speaker `ERes2Net-base 200k` 做了候选核验：官方 ONNX 为 `39,593,765` bytes、SHA-256 `e2d2048292e055f7b61cdec3db010503f35369b245bf0b3bbad021c9a91e4053`，在当前随 App 发布的 sherpa `1.13.6` + ORT `1.28.0` 上可加载并输出 512 维 embedding，ABI 与资源预算可兼容。但 Sherpa 官方 diarization 组合仍使用当前 `speech_eres2net_base_sv_zh-cn_3dspeaker_16k@v1.0.1`，候选没有在本项目固定 corpus 上证明 DER 更好；因此当前 source lock 和默认 pack 不变。`ERes2NetV2` 为 192 维，本期不为候选模型改写固定 512 维 adapter ABI或增加并行模型分支。

远端发布面固定为：

```text
https://download.myagents.io/models/speech/sets/<pack-revision>/manifest.json
https://download.myagents.io/models/speech/sets/<pack-revision>/manifest.json.sig
https://download.myagents.io/models/speech/assets/sha256/<sha256>/<filename>
```

远端 manifest bytes 必须与 App/Worker 编译内 source lock 完全一致，签名才会被接受。远端 JSON 不能提供新的本地路径、host、模型或 native library。

发布 owner 是根目录 `publish_speech_model_set.sh`：它先调用 `scripts/prepare-speech-model-mirror.mjs`，将运行时 source lock 与 release-only `model-pack-mirror-origin-lock.json` 按 exact asset/legal ID join，复用 `acquireLockedResource` 的 content-addressed cache 从锁定 GitHub origin 取得并校验七个 source。publisher 先补传缺失的 content-addressed object 并逐个从公网完整回读比对，再调用 `scripts/package-speech-model-set.mjs` 原样复制编译 source lock、复用 Tauri updater signer 生成 detached signature，最后发布 manifest/signature。任何已有 source/manifest 内容漂移或签名失配都 fail closed，不接受 force、revision、asset、URL 或 trust-root 覆盖。GitHub origin lock 不进入 App 运行时；完整 source lock 语义仍由 Rust/Worker 的同一解析与测试裁决。

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
4. 顺序下载锁定 asset 到 0700 private 目录中的 0600 `create_new` 文件；每个响应只允许 HTTPS `download.myagents.io` 固定 host，逐 chunk 执行 exact size、SHA-256 与总下载硬上限。
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

Tauri 提供 `cmd_speech_model_pack_status/install/remove`。状态为 `not_installed | checking | downloading | verifying | installing | removing | ready | update_available | error`，另带 `usable`、active/available revision、公开资源字节数与结构化 `lastErrorCode`。只读 status 只检查本地 owner，不联网；显式安装依次投影第一方清单/签名核验、固定资源下载、安全解包与文件校验、真实模型加载及原子激活，只有下载阶段展示 bytes/百分比。App revision 变化后，旧 pack 只有在本地 manifest 仍能通过 App updater trust root 验签且 identity 与 pointer 一致时才投影 `update_available`，但 `usable=false`、绝不交给 Worker；损坏或伪造 pointer 投影 `error`。

这些状态只是现有 `SpeechModelPackManager` operation 与持久 pointer 的投影，不是新的持久状态机。Renderer 在操作期间轮询同一 command；没有第二套 downloader、事件 owner、安装授权或错误 store。主要错误族：

- `SPEECH_NATIVE_RUNTIME_UNAVAILABLE`：随包 Worker/native/shared ORT 不完整；
- `SPEECH_RESOURCE_NETWORK`：固定网络路径不可用或跳转 host 不允许；
- `SPEECH_RESOURCE_MANIFEST_INVALID` / `SPEECH_RESOURCE_SIGNATURE_INVALID`：发布 manifest 或签名不可信；
- `SPEECH_RESOURCE_DOWNLOAD_INVALID` / `SPEECH_RESOURCE_ARCHIVE_INVALID` / `SPEECH_RESOURCE_PACK_INVALID`：下载、archive 或安装 inventory 漂移；
- `SPEECH_MODEL_LOAD_FAILED` / `SPEECH_MODEL_LOAD_TIMEOUT`：真实最小加载未通过；
- `SPEECH_RESOURCE_BUSY`：并发 mutation 或仍有 workload 引用资源；
- `SPEECH_RESOURCE_CORRUPT`：active pointer / pack 的持久校验失败。

日志只记录 operation、revision、公开资源 bytes、generation、阶段与结构化错误码；不得记录用户音频、transcript、完整路径或远端原始错误正文。

## 排障顺序

1. 先在 `~/.myagents/logs/unified-<本地日期>.log` 搜索 `[record]`、`[recording]`、`[speech]` 与结构化错误码；不要要求用户上传音频或 transcript。
2. 录音无法开始时先区分 `RECORDING_MICROPHONE_PERMISSION_REQUIRED`、`RECORDING_MICROPHONE_UNAVAILABLE`、`RECORDING_SCREEN_PERMISSION_REQUIRED`、`RECORDING_SYSTEM_AUDIO_UNAVAILABLE`、`RECORDING_PIPEWIRE_UNAVAILABLE` 与 `RECORDING_DEVICE_CHANGED`。macOS 麦克风授权依赖 `Info.plist` 用途说明与签名产物中的 `com.apple.security.device.audio-input` entitlement；缺任一项时 TCC 都可能在弹窗前拒绝。entitlement 变更后必须重新构建并启动新的 `.app`，前端热重载不会改变旧进程的签名能力。权限或设备问题由平台 capture backend 处理，不通过重装模型修复。
3. 音频已保存但没有转录时查看 Record 的 transcription status 与模型 pack status。资源未 ready 时安装/修复资源；历史 Record 仍需用户手动点击“开始转录”。
4. Agent 看不到 job 时必须在原发起 Session 运行 `myagents speech list`；不要通过增加 `--sessionId` 或全局 list 绕过隔离。
5. 资源准备或安装失败时依次核对 target native manifest、共享 ORT identity、第一方 manifest/signature、pack 文件 hash 与最小真实加载。不得回退系统 ORT、在线 ASR、用户 cache 或临时下载。
