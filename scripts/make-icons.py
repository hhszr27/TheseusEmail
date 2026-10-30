#!/usr/bin/env python3
"""生成 MailForge 托盘图标与应用图标。

产物（build/icons/）：
  tray-icon.png            托盘基础图标（信封）
  tray-badge-1..9.png      未读 1-9 徽章变体
  tray-badge-9p.png        未读 9+ 徽章变体
  icon.png                 应用图标（256）
  icon.ico                 应用图标（多尺寸，Windows 打包用）

用法：python scripts/make-icons.py
依赖：Pillow（本机系统 Python 自带）。
"""
from __future__ import annotations

import os
import sys

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build", "icons")
FONT_BOLD = r"C:\Windows\Fonts\segoeuib.ttf"
FONT_BOLD_FALLBACK = r"C:\Windows\Fonts\arialbd.ttf"

BLUE = (31, 111, 219, 255)        # 信封主体
BLUE_DARK = (22, 88, 178, 255)    # 底部暗带（层次）
WHITE = (255, 255, 255, 255)
RED = (232, 17, 35, 255)          # 徽章红（Windows 通知红）

SS = 4  # 超采样倍率


def font(size: int) -> ImageFont.FreeTypeFont:
    for candidate in (FONT_BOLD, FONT_BOLD_FALLBACK):
        if os.path.exists(candidate):
            return ImageFont.truetype(candidate, size)
    raise SystemExit("找不到可用粗体字体（segoeuib.ttf / arialbd.ttf）")


def draw_envelope(size: int) -> Image.Image:
    """在 size×size 画布上画信封（透明背景）。"""
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = s * 0.06
    x0, y0, x1, y1 = pad, s * 0.16, s - pad, s * 0.88
    radius = s * 0.10

    # 主体圆角矩形 + 底部暗带
    draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=BLUE)
    band_h = (y1 - y0) * 0.16
    draw.rounded_rectangle([x0, y1 - band_h, x1, y1], radius=radius, fill=BLUE_DARK)
    # 暗带顶部重新裁回圆角：用主体色补画中间区域的上半圆角
    draw.rectangle([x0, y1 - band_h, x1, y1 - band_h + radius], fill=BLUE_DARK)
    draw.rounded_rectangle([x0, y0, x1, y1 - band_h + radius], radius=radius, fill=BLUE_DARK)
    draw.rounded_rectangle([x0, y0, x1, y1 - band_h], radius=radius, fill=BLUE)

    # 信封盖 V 形（白色粗线，圆角接头）
    lw = max(2, int(s * 0.055))
    cx = s / 2
    vy = y0 + (y1 - y0) * 0.42
    draw.line([(x0 + lw * 0.5, y0 + lw * 0.5), (cx, vy)], fill=WHITE, width=lw, joint="curve")
    draw.line([(cx, vy), (x1 - lw * 0.5, y0 + lw * 0.5)], fill=WHITE, width=lw, joint="curve")

    return img.resize((size, size), Image.LANCZOS)


def add_badge(base: Image.Image, label: str) -> Image.Image:
    size = base.width
    s = size * SS
    img = base.resize((s, s), Image.LANCZOS)
    draw = ImageDraw.Draw(img)

    r = s * 0.30
    cx, cy = s - r * 0.92, s - r * 0.92
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=RED)

    # 数字居中
    if label == "9+":
        f = font(int(r * 1.05))
    else:
        f = font(int(r * 1.35))
    bbox = draw.textbbox((0, 0), label, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    draw.text((cx - tw / 2 - bbox[0], cy - th / 2 - bbox[1]), label, font=f, fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


def save(img: Image.Image, name: str) -> None:
    path = os.path.join(OUT_DIR, name)
    img.save(path)
    print(f"  {name} ({img.width}x{img.height})")


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    print("生成图标 ->", OUT_DIR)

    base32 = draw_envelope(32)
    save(base32, "tray-icon.png")
    for i in range(1, 10):
        save(add_badge(base32, str(i)), f"tray-badge-{i}.png")
    save(add_badge(base32, "9+"), "tray-badge-9p.png")

    icon256 = draw_envelope(256)
    save(icon256, "icon.png")
    icon256.save(
        os.path.join(OUT_DIR, "icon.ico"),
        sizes=[(16, 16), (32, 32), (48, 48), (256, 256)],
    )
    print("  icon.ico (16/32/48/256)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
