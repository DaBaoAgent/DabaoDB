# DabaoDB — Hypit 视频项目（火山方舟 Seedance 接入）

Hypit 的「视频项目」目录。工具本体在 `D:\@kaifa\hypit`（Distribution），本项目只放
源码（`.svml`/`.svrun`）、项目组件和 Runtime Profile。

## 目录

```
DabaoDB/
├── hypit.runtime.json                      # Runtime Profile（选服务 + 绑能力 + 凭据引用）
├── probe.svml / probe.svrun                # 最小验证用例：一条 5s 文生视频
├── package.json                            # 依赖本项目的 provider 包
├── node_modules/@volcengine/provider-ark-seedance -> ../packages/provider-ark-seedance
└── packages/provider-ark-seedance/         # 自己写的 Provider：对接火山方舟 Ark
    ├── src/provider.ts                     # 能力映射 / 提交 / 轮询 / 收集 / 价目
    ├── src/activation.ts                   # Profile 配置解析与激活
    └── dist/                               # tsc 产物（Hypit 运行的是这里的 JS）
```

## 常用命令

```bash
# 用仓库里的 CLI，指定项目工作区
H="node D:/@kaifa/DabaoDB/hypit/bin/hypit.mjs"; P="D:/@kaifa/DabaoDB/projects/DabaoDB"

$H check   "$P/probe.svml"  --workspace "$P"                              # 校验源码（免费）
$H doctor  --workspace "$P" --runtime "$P/hypit.runtime.json"             # 体检 Profile/凭据（免费）
$H plan    "$P/probe.svrun" --workspace "$P" --runtime "$P/hypit.runtime.json"   # 出片计划（免费）
$H pricing "$P/probe.svrun" --workspace "$P" --runtime "$P/hypit.runtime.json"   # 价目（免费）
$H build   "$P/probe.svrun" --workspace "$P" --runtime "$P/hypit.runtime.json" --follow   # 真出片（花钱）
$H get     <build-id> --output final.video --to out.mp4 --workspace "$P"  # 导出（注意：get 不接受 --runtime）
```

改完 Provider 源码必须重新编译，Hypit 读的是 `dist/`：

```bash
node "D:/@kaifa/DabaoDB/hypit/node_modules/typescript/bin/tsc" -p \
  "D:/@kaifa/DabaoDB/projects/DabaoDB/packages/provider-ark-seedance/tsconfig.json"
```

## 换模型（改 Profile 一处）

`hypit.runtime.json` 里 `endpoints["ark.mini"].config.capability` 取：
`seedance-2-mini`（默认，最便宜）｜`seedance-2-fast`｜`seedance-2`｜`seedance-2.5`
并把 `bindings` 的键同步改成 `"@hypit/seedance@1#<同一个名字>"`。

火山 Ark 模型 ID 与变体的对应写在 `src/provider.ts` 的 `arkModelByCapability`：

| Hypit 变体 | 火山 Ark 模型 | 分辨率 | 单价（元/百万 token） | 720p/5s 约 |
|---|---|---|---|---|
| seedance-2-mini | doubao-seedance-2-0-mini-260615 | 480p/720p | 23 | **2.50 元** |
| seedance-2-fast | doubao-seedance-2-0-fast-260128 | 480p/720p | 37 | 4.03 元 |
| seedance-2 | doubao-seedance-2-0-260128 | 480p/720p/1080p/4k | 46（4k 26） | 5.01 元 |
| seedance-2.5 | doubao-seedance-2-5-260628 | 480p/720p/1080p | 未取到官方价 | — |

> 火山按 completion token 计费；实测 480p/5s = 50,638 token，720p/5s = 108,900 token。
> 带视频参考的请求更便宜（mini 14 元/百万）。

## 凭据

Ark API Key 存放在 **Windows 凭据库**（`credential-store-os`），不落在任何文件里。
重新配置：`hypit auth login ark.mini --workspace "$P" --runtime "$P/hypit.runtime.json" --from <密钥文件>`
查看状态（只显示是否已配置）：`hypit auth status ark.mini ...`

## 生成记录

| 日期 | 用例 | 规格 | Build | 实际用量 | 折算费用 |
|---|---|---|---|---|---|
| 2026-09-15 | `lighter218-15s.svml`（爱优护轻便侠218 真人讲解，参考同行视频结构，无字幕）| mini / 720p / 9:16 / 15s / 带口播 | `bld_20260915T131457419Z_4041134339`（Ark 任务 `cgt-20260915211501-f94xb`）| 324,900 tokens / 3分08秒 | ≈7.47 元 |
| 2026-09-15 | `qbx-shot1..3.svml`（学安徽乐姐：3 镜 ×5s 旁白版，无出镜讲解员，无字幕，折叠动作限 0.5s）| mini / 720p / 9:16 / 3×5s → 拼 15.30s | `bld_…A93A100727 / …E68B17E28E / …44F9F267A8`（Ark `cgt-…vqvwr / …rx7wf / …fq7fr`）| 3×108,900 = 326,700 tokens | ≈7.47 元 |

产物：`out/lighter218-15s-01.mp4`、`out/qingbianxia-15s-01.mp4`（3 段源片在 `out/shot/`）。

**交付规则（老板 2026-09-15 定）：成片一律直接输出到**
`D:\BaiduSyncdisk\19 最近待办\AI视频\同行高播放视频\`（不再建子目录）。

经验：15s 纯口播+产品演示用 `ReferenceVideo` + 产品图（最多 9 张，图缩小到 ≤1024 宽再内联，
否则原始 16MB 产品图的 base64 会过大）；`web-search` 属性只有 `TextVideo` 支持，
`ReferenceVideo` 写它会直接报错；prompt 里显式写"不要出现任何字幕/文字/水印"可有效避免烧字。

## 已知限制

- `webSearch` 端口：未验证 Ark 的对应字段，端点明确拒绝 `web-search="true"`（默认 false 正常用）
- 参考视频/音频走 data URL 内联提交，未验证 Ark 对超大内联视频的上限；超大素材建议先转成可公网访问的 URL
- 无取消实现（Ark 的 `DELETE` 在任务 running 时会被拒）
