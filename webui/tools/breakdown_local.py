#!/usr/bin/env python3
"""参考视频拆解流水线（生产工厂版）—— ffmpeg 抽帧 + **纯本地** ASR。

与 Hermes 技能库里的 `reference-video-breakdown/scripts/breakdown.py` 同源，
但**已彻底去掉云端 ASR（DashScope）**：没有云端开关、没有云端回落、不读任何云端凭据，
转写只走本地 faster-whisper（免费、离线）。

用法:
    python breakdown_local.py <video> [--out DIR] [--fps 0.5] [--no-asr] [--whisper-model <名字或本地模型目录>]

产物 (在 --out 目录下):
    00-meta.txt            元数据（时长/分辨率/帧率/音轨）
    frames/frame-%04d.jpg  密集抽帧（默认每 2 秒 1 帧，宽 720）
    sheets/sheet-%02d.jpg  3x3 联系表（喂给多模态模型读帧）
    keyframes/key-%03d.jpg 场景切换关键帧（镜头分界）
    audio/ref.wav          16k 单声道音轨
    transcript.txt         口播全文（本地 ASR 结果；失败时写原因）
    报告骨架.md             报告模板
"""
from __future__ import annotations

import argparse
import os
import pathlib
import subprocess
import sys
import time


def run(cmd: list[str]) -> tuple[int, str]:
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def ffprobe_meta(video: str) -> str:
    code, out = run([
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration,size,bit_rate",
        "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
        "-of", "default=noprint_wrappers=1", video,
    ])
    return out.strip() if code == 0 else f"ffprobe 失败:\n{out}"


def local_transcribe(wav: str, model_size: str) -> str:
    """本地 faster-whisper：免费、离线。model_size 可以是模型名，也可以是本地模型目录。"""
    # 国内网络直连 HuggingFace 常常下不动模型，默认走镜像（可用 HF_ENDPOINT 覆盖）
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001
        return f"[本地 ASR 不可用] 缺少 faster_whisper: {exc}"
    candidates = [model_size] if pathlib.Path(model_size).exists() else [model_size, "base"]
    last = ""
    for size in candidates:
        try:
            t0 = time.time()
            model = WhisperModel(size, device="cpu", compute_type="int8")
            segments, info = model.transcribe(wav, language="zh", vad_filter=True, beam_size=5)
            lines = [
                f"(本地 faster-whisper {pathlib.Path(size).name if pathlib.Path(size).exists() else size}"
                f", 语种={info.language}, 时长={info.duration:.1f}s, 耗时={time.time() - t0:.1f}s)"
            ]
            for seg in segments:
                lines.append(f"  [{seg.start:.1f}-{seg.end:.1f}s] {seg.text.strip()}")
            return "\n".join(lines)
        except Exception as exc:  # noqa: BLE001
            last = f"{size}: {exc}"
    return f"[本地 ASR 失败] {last}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--out", default="")
    ap.add_argument("--fps", type=float, default=0.5, help="抽帧频率，默认 0.5（每 2 秒 1 帧）")
    ap.add_argument("--no-asr", action="store_true")
    ap.add_argument("--whisper-model", default="small",
                    help="本地 faster-whisper 模型名或本地模型目录（推荐直接指向已下载目录，免下载）")
    args = ap.parse_args()

    video = os.path.abspath(args.video)
    if not os.path.exists(video):
        print(f"找不到视频: {video}")
        return 1
    out = pathlib.Path(args.out) if args.out else pathlib.Path(video).with_suffix("").parent / (pathlib.Path(video).stem[:40] + "-拆解")
    for sub in ("frames", "sheets", "keyframes", "audio"):
        (out / sub).mkdir(parents=True, exist_ok=True)

    meta = ffprobe_meta(video)
    (out / "00-meta.txt").write_text(meta, encoding="utf-8")
    print("== 元数据 ==\n" + meta)

    code, log = run(["ffmpeg", "-v", "error", "-i", video, "-vf", f"fps={args.fps},scale=720:-2", "-q:v", "3",
                     str(out / "frames" / "frame-%04d.jpg"), "-y"])
    print(f"== 抽帧 =={'OK' if code == 0 else '失败'} {len(list((out / 'frames').glob('*.jpg')))} 张")

    code, log = run(["ffmpeg", "-v", "error", "-i", video, "-vf", f"fps={args.fps},scale=400:-2,tile=3x3",
                     "-frames:v", "9", "-q:v", "3", str(out / "sheets" / "sheet-%02d.jpg"), "-y"])
    sheets = sorted((out / "sheets").glob("*.jpg"))
    print(f"== 联系表 =={len(sheets)} 张 {[s.name for s in sheets]}")

    keyframes = out / "keyframes"
    for threshold in ("0.15", "0.06"):
        for stale in keyframes.glob("*.jpg"):
            stale.unlink()
        run(["ffmpeg", "-v", "error", "-i", video, "-vf", f"select='gt(scene,{threshold})',scale=720:-2",
             "-vsync", "vfr", "-q:v", "3", str(keyframes / "key-%03d.jpg"), "-y"])
        keys = sorted(keyframes.glob("*.jpg"))
        if keys:
            print(f"== 场景关键帧 =={len(keys)} 张（阈值 {threshold}，镜头分界）")
            break
    else:
        print("== 场景关键帧 ==0 张（画面无显著跳变，改用密集帧推分镜）")

    code, log = run(["ffmpeg", "-v", "error", "-i", video, "-vn", "-ac", "1", "-ar", "16000",
                     "-c:a", "pcm_s16le", str(out / "audio" / "ref.wav"), "-y"])
    wav = out / "audio" / "ref.wav"
    print(f"== 音轨 =={'OK' if code == 0 else '失败'} {wav.stat().st_size if wav.exists() else 0} bytes")

    if args.no_asr:
        (out / "transcript.txt").write_text("[本次未做 ASR]", encoding="utf-8")
    elif wav.exists():
        print(f"== 本地 ASR 转写中（faster-whisper: {args.whisper_model}）…")
        text = local_transcribe(str(wav), args.whisper_model)
        (out / "transcript.txt").write_text(text, encoding="utf-8")
        print(text[:600])
    else:
        (out / "transcript.txt").write_text("[无音轨，跳过 ASR]", encoding="utf-8")

    (out / "报告骨架.md").write_text(
        f"""# 参考视频拆解：{pathlib.Path(video).name}

## 1. 元数据
```text
{meta}
```

## 2. 分镜表（对照 keyframes/ 与 sheets/）
| # | 时间 | 画面 | 镜头运动 | 产品出现 | 画面文字/字幕 |
|---|---|---|---|---|---|

## 3. 口播全文（见 transcript.txt）
```text
{(out / 'transcript.txt').read_text(encoding='utf-8') if (out / 'transcript.txt').exists() else ''}
```
""",
        encoding="utf-8",
    )
    print(f"\n全部产物 -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
