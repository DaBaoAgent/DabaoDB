# 爱优护对标视频全自动生产工厂 · WebUI

对着「同行爆款对标视频 + 我方产品图」，一键跑完整条生产线：
**拆解对标 → 读帧理解 → 分镜提示词 → 渲染源码 → 生成镜像 → 合成 → 导出**，全程实时进度与日志。

- 后端：Node 原生 `http`（**零 npm 依赖**，只用内置模块）
- 前端：原生 HTML/CSS/JS 单页（无构建），深色「苹果 18」透明玻璃风格
- 大脑：`deepseek-flash`（多模态，base64 读帧 + 写拆分报告 + 写 Seedance 提示词）
- 转写：**只走本地 faster-whisper**（免费、离线，不走任何云端 ASR）
- 出片：Hypit CLI + 火山方舟 Seedance（BYOK，按 token 计费）

## 启动

双击 **`start.bat`**（或 `node server.js`），浏览器自动打开 <http://localhost:8899>。

命令行参数（可选）：

```bash
node server.js --port 8899 --no-open            # 换端口 / 不开浏览器
node server.js --dry-stages=generate            # 演练模式：跳过某个阶段（开发者自测用，不花钱）
```

## 目录

```
webui/
├── server.js                 后端：静态服务 + API + SSE + 单任务队列
├── lib/pipeline.js           流水线：9 个阶段、逐镜生成、合成、导出
├── lib/deepseek.js           大脑层：deepseek-flash 文本/多模态调用
├── lib/util.js               子进程流式执行、ffmpeg/ffprobe、路径
├── public/                   前端（index.html / app.js / style.css / assets/logo.png）
├── config.json               ★ 配置（Key 只留后端；已在 .gitignore 里）
├── data/                     运行时数据（上传、任务、日志；已在 .gitignore 里）
└── start.bat                 双击启动
```

## config.json 关键项

| 键 | 说明 |
|---|---|
| `deepseek.apiKey` | DeepSeek Key；留空则自动回落读 `~/AppData/Local/hermes/.env` 的 `DEEPSEEK_API_KEY` |
| `paths.hypitCli` | Hypit CLI：`D:/@kaifa/DabaoDB/hypit/bin/hypit.mjs` |
| `paths.project` | 视频项目工作区：`D:/@kaifa/DabaoDB/projects/DabaoDB` |
| `paths.runtime` | Runtime Profile：`hypit.runtime.json` |
| `paths.python` / `paths.breakdownScript` | 本地拆解脚本（`tools/breakdown_local.py`，**只走本地转写**）与解释器 |
| `paths.whisperModel` | 本地 whisper 模型目录（默认用 modelscope 缓存的 medium，免下载） |
| `paths.logoSource` | 贴真标用的爱优护 logo |
| `paths.outDir` | 成片落地目录（项目 `out/`） |
| `defaults` | 界面首次打开的默认值（产品名 / 勾选组 / 规格） |

## 界面

- **左栏**：① 对标视频上传（拖拽/点击，带上传进度）② 产品名称 ③ 产品参考图（≤9 张，缩略图预览可删）④ 学习对标勾选组（旁白/口播/语气/语速/风格/贴真标）⑤ 生成参数（模型档/分辨率/画幅/分镜数/每镜时长/声音）⑥ **大生成按钮 + 续跑按钮**
- **右栏**：环形大进度 + 5 步阶段条（拆解→分镜→生成镜像→合成→导出）+ 每镜缩略图实时点亮 + 成片预览播放器（支持拖动进度条）+ 拆解报告/分镜方案折叠卡 + 失败横幅（把上游报错翻成人话并给出下一步）
- **底部**：操作日志（中文阶段说明 + 可折叠的 CLI 原始输出，含 token/耗时/报错原文），带自动滚动、复制、下载
- **历史标签页**：每次任务的产品名/规格/勾选项/预计花费/成片时长/耗时/成片路径，可**回放**、**看日志**、**续跑**、**一键重生**
- 参数与素材（含已上传文件路径）记在 localStorage，刷新不丢；同一时刻只跑一个任务，其余排队

## 续跑（断点续做，不重复花钱）

「续跑」按钮在「开始生成视频」右边，只有在上次任务**失败**或**没出片**时可用（跑动中会自动禁用）。

按下后：

1. 新任务自动**接手**上次任务的产物：`拆解/`、`assets/`、`shotNN.svml/.svrun`、`分镜提示词.json`、`out/`（已出片的镜）
2. `prepare / breakdown / analyze / storyboard / render` 五个阶段标注为**复用**，日志逐条打出 `↻ 续跑：复用上一次的…`
3. 直接进 `plan → generate`，**已经生成的镜头直接复用 mp4，不再花钱**
4. 历史页里也可以对某条失败任务单独点「续跑」

## 自愈：含真人的参考图会被火山拒收

火山方舟（Seedance）**不接受含真人的图当参考图**，实测报错：

```
Ark /contents/generations/tasks returned HTTP 400:
The request failed because the input image 'content[5]' may contain real person.
```

处理链（全自动，无需人工）：

1. 失败时用 `hypit inspect <build-id> --json` 挖出**上游原始报错**（不是干巴巴的 `outcome=failed`），写进日志与失败横幅
2. 若是"含真人"，从报错里解析 `content[N]`（`content[0]` 是文本，图片从 `N=1` 起，故图序 = `N-1`）
3. 自动剔除该图 → 挪到 `assets/_rejected/` → 重写该镜 `.svml` → **自动重试**（最多 12 次）
4. 已出片的镜不会被重写；参考图全被剔完仍失败才会报错退出

**建议**：产品参考图只放纯产品图，别放带真人模特的照片（封面/详情页素材里最容易混进这类图）。

## 流水线细节（9 阶段）

| 阶段 | 动作 | 花钱 |
|---|---|---|
| prepare | 校验素材、复制成 ASCII 名、ffprobe 读元数据 | 否 |
| breakdown | `tools/breakdown_local.py`：抽帧 + 联系表 + 场景关键帧 + 16k 音轨 + **本地 faster-whisper 转写（无云端分支、无云端凭据）** | 否 |
| analyze | `deepseek-flash` 逐张读联系表 → 汇总成拆解报告 + 参考分镜表 | 极少 |
| storyboard | `deepseek-flash` 按勾选项写每镜 Seedance 提示词（含口播台词） | 极少 |
| render | 产品图压到 1024 宽 → 写 `shotNN.svml/.svrun` → `hypit check` 校验 | 否 |
| plan | `hypit plan` 检查 preflight + 本地估价（token × 单价） | 否 |
| generate | 逐镜 `hypit build --json` → 轮询 `status` → `get` 导出该镜 mp4 | **是（Seedance）** |
| compose | 多镜 `ffmpeg concat` 拼接；单镜直接用 | 否 |
| export | 复制到 `out/`（命名 `产品名_时间戳.mp4`）、抽封面帧、预览 | 否 |

### 写进提示词的硬规则（来自老板/技能库）

1. 勾选「学习对标」= **完全照对标视频** 的语气、语速、风格与结构
2. **折叠/展开动作必须在 0.5 秒内完成**（写成「瞬发、一晃即折叠」），否则模型逐帧演算机械结构会穿帮
3. 口播口径保留「**3 秒折叠**」（画面短促 ≠ 台词改口）
4. 勾选「贴真标」→ 车身必须出现 `Ainsnbot`（中间 `sn` 红色 + 圆形银 `A` 徽标），并把爱优护 logo 作为参考图传入；不勾选则明令画面无任何字母/文字/logo
5. 一律写死：**除商标外不要任何字幕、花字、水印、贴纸、UI 元素**
6. 不复刻参考视频里他人的人物形象、品牌与水印

## 自测脚本（改完代码先跑这个）

```bash
node tools/smoke.mjs          # 冒烟：上传素材 → 起任务 → 轮询进度（打印每步日志）
node tools/resume-check.mjs   # 续跑验证：对最近一条失败任务按续跑，观察复用与自愈
```

两个脚本只打 HTTP，不动前端；配套 `--dry-stages=generate` 起服务就能零成本验证全链路。

## 排障

| 症状 | 原因 / 处理 |
|---|---|
| 界面徽章显示「Key 缺失」 | `config.json` 的 `deepseek.apiKey` 与 `hermes/.env` 的 `DEEPSEEK_API_KEY` 都没有 |
| 日志/横幅出现 `may contain real person` | 参考图含真人 → 程序已自动剔除重试；连续多次说明多张都有真人，换成纯产品图 |
| `UNSUPPORTED_SOURCE_ASSET … must be relative` | `.svml` 里素材路径必须写成 `./assets/xxx.jpg`（已修） |
| `MANAGED_PROGRAM_DOWN (hyperframes.local)` | `~/.hyperframes/config.json` 的 `lastSkillsCheck` 过期导致 CLI 启动变慢；见工具仓库 `SETUP-LOCAL.md` §3.2 |
| 本地转写报缺模型 | 改 `paths.whisperModel` 指向已缓存的模型目录（如 modelscope 的 `faster-whisper-medium`） |
| 生成很慢 | 单镜 720p/15s 实测 **3 分钟左右**（178s 出片）；日志里每 6 秒报一次状态 |
| 失败后不想从零重跑 | 点「续跑」：复用拆解/分镜/已出片的镜，只补没做完的部分 |

## 已知限制

- 一次只跑一个任务（排队），没有多任务并行
- 贴真标依赖视频模型渲染长商标，实测**可能被渲染错**（如 `Ainsnbot` → `Airbot`）；可靠做法是生成干净底板后用 ffmpeg 叠真实商标贴片（见技能库 `reference-video-breakdown` 的老板硬规则第 4 条）
- 无「取消已提交的 Ark 任务」实现（Ark 在 running 时拒绝 DELETE），取消只能中断本地等待
- 估价按实测 token 表线性外推，4K/1080p 未实测
