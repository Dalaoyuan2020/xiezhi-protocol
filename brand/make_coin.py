# 廌点 · 质感金币：金属外圈 + 齿边 + 珠圈 + 斜面 + 拉丝场 + 镜面高光 + 浮雕小兽
# 用法：python3.11 brand/make_coin.py enamel|gold brand/xiezhi-mascot.png brand/zhidian-coin.png（需 numpy + Pillow）
import numpy as np, sys
from PIL import Image, ImageFilter, ImageChops
S = 2400; c = S / 2
yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
r = np.hypot(xx - c, yy - c); ang = np.arctan2(yy - c, xx - c)
t = (xx + yy) / (2 * S)                      # 0 左上（迎光）→ 1 右下（背光）
STOPS = np.array([[255, 252, 228], [248, 214, 120], [212, 156, 52], [138, 92, 22], [70, 44, 8]], np.float32)
def gold(v):
    v = np.clip(v, 0, 1) * (len(STOPS) - 1); i = np.clip(v.astype(int), 0, len(STOPS) - 2); f = (v - i)[..., None]
    return STOPS[i] * (1 - f) + STOPS[i + 1] * f
R_EDGE, R_REED, R_RIM, R_BEV = 1170, 1110, 975, 935
img = np.zeros((S, S, 3), np.float32)
reed = 0.5 + 0.5 * np.sign(np.sin(ang * 180))
img = np.where((r <= R_EDGE)[..., None] & (r > R_REED)[..., None], gold(0.15 + 0.6 * t + 0.18 * reed), img)
rim = gold(0.0 + 0.95 * t - 0.15 * ((r - R_RIM) / (R_REED - R_RIM)))
img = np.where(((r <= R_REED) & (r > R_RIM))[..., None], rim, img)
img = np.where(((r <= R_RIM) & (r > R_BEV))[..., None], gold(0.95 - 0.9 * t), img)        # 内斜面：反向明暗，看起来凹进去
rng = np.random.default_rng(7); noise = rng.normal(0, 1, (S, S)).astype(np.float32)
noise = np.array(Image.fromarray(((noise * 20) + 128).clip(0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)), np.float32) / 255 - 0.5
mode = sys.argv[1] if len(sys.argv) > 1 else "enamel"
if mode == "enamel":
    RED0, RED1 = np.array([206, 58, 60], np.float32), np.array([120, 18, 26], np.float32)
    k = np.clip(0.15 + 0.85 * t + 0.08 * noise, 0, 1)[..., None]
    field = RED0 * (1 - k) + RED1 * k
    field = field * (1 + 0.025 * np.sin(r / 5.5))[..., None]                       # 釉下同心纹
else:
    field = gold(0.30 + 0.45 * t + 0.035 * np.sin(r / 5.5) + 0.12 * noise)           # 同心细纹 + 拉丝
img = np.where((r <= R_BEV)[..., None], field, img)
for rr in (R_REED, R_RIM, R_BEV):
    g = np.clip(1 - np.abs(r - rr) / 4, 0, 1)[..., None]
    img = img * (1 - 0.55 * g)
# 珠圈
beads = np.zeros((S, S), np.float32); RB, N = 1042, 96
for k in range(N):
    a = 2 * np.pi * k / N; bx, by = c + RB * np.cos(a), c + RB * np.sin(a)
    d = np.hypot(xx[int(by)-24:int(by)+24, int(bx)-24:int(bx)+24] - bx, yy[int(by)-24:int(by)+24, int(bx)-24:int(bx)+24] - by)
    beads[int(by)-24:int(by)+24, int(bx)-24:int(bx)+24] = np.maximum(beads[int(by)-24:int(by)+24, int(bx)-24:int(bx)+24], np.clip(1 - d / 17, 0, 1))
bead_col = gold(0.05 + 0.55 * t - 0.25 * (beads ** 0.5))
img = np.where((beads > 0)[..., None], img * (1 - beads[..., None]) + bead_col * beads[..., None], img)
coin = Image.fromarray(img.clip(0, 255).astype(np.uint8)).convert("RGBA")
alpha = Image.fromarray((np.clip(R_EDGE + 1 - r, 0, 1) * 255).astype(np.uint8)); coin.putalpha(alpha)

# 小兽
m = Image.open(sys.argv[2]).convert("RGBA")
mh = 1300; mw = int(m.width * mh / m.height); m = m.resize((mw, mh), Image.LANCZOS)
ox, oy = int(c - mw / 2), int(c - mh / 2 + 10)
a = m.getchannel("A")
if mode == "gold":
    lum = np.array(m.convert("L"), np.float32) / 255
    emb = np.array(Image.fromarray((lum * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(3)).filter(ImageFilter.EMBOSS), np.float32) / 255 - 0.5
    lt = (np.mgrid[0:mh, 0:mw][1] + np.mgrid[0:mh, 0:mw][0] + ox + oy) / (2 * S)
    col = gold(np.clip(0.95 - 0.75 * lum + 0.25 * lt - 1.1 * emb, 0, 1))
    m = Image.fromarray(col.clip(0, 255).astype(np.uint8)).convert("RGBA"); m.putalpha(a)
# 金属描边（像珐琅徽章的金线）+ 投影，让小兽浮起来
stroke_a = a.filter(ImageFilter.MaxFilter(11)).filter(ImageFilter.GaussianBlur(1.2))
lt = (np.mgrid[0:mh, 0:mw][1] + np.mgrid[0:mh, 0:mw][0] + ox + oy) / (2 * S)
stroke = Image.fromarray(gold(0.05 + 0.7 * lt).clip(0, 255).astype(np.uint8)).convert("RGBA"); stroke.putalpha(stroke_a)
shadow = Image.new("RGBA", (mw, mh), (60, 36, 6, 0)); shadow.putalpha(stroke_a.filter(ImageFilter.GaussianBlur(7)).point(lambda v: int(v * 0.5)))
layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
layer.alpha_composite(shadow, (ox + 6, oy + 9)); layer.alpha_composite(stroke, (ox, oy)); layer.alpha_composite(m, (ox, oy))
# 外轮廓重描：沿抠图边缘画一圈均匀的深色线，盖住放大后发毛的原始黑线
er = a.filter(ImageFilter.MinFilter(13))
band = np.clip(np.array(a, np.float32) - np.array(er, np.float32), 0, 255)
band = Image.fromarray(band.astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.0))
line = Image.new("RGBA", (mw, mh), (38, 24, 12, 0) if mode == "enamel" else (90, 58, 14, 0)); line.putalpha(band)
layer.alpha_composite(line, (ox, oy))
inner = Image.fromarray((255 - np.array(a)).astype(np.uint8)).filter(ImageFilter.GaussianBlur(10))
inner_a = Image.fromarray((np.array(inner, np.float32) * (np.array(a, np.float32) / 255) * 0.35).clip(0, 255).astype(np.uint8))
ish = Image.new("RGBA", (mw, mh), (70, 40, 0, 0)); ish.putalpha(inner_a)
layer.alpha_composite(ish, (ox, oy))
# 小兽上的釉面高光
gl = np.clip(1 - np.mgrid[0:mh, 0:mw][0] / (mh * 0.55), 0, 1) * 0.16
glare = Image.new("RGBA", (mw, mh), (255, 255, 255, 0)); glare.putalpha(Image.fromarray((np.array(a, np.float32) / 255 * gl * 255).astype(np.uint8)))
layer.alpha_composite(glare, (ox, oy))
coin.alpha_composite(Image.composite(layer, Image.new("RGBA", (S, S), (0, 0, 0, 0)), Image.fromarray(((r <= R_BEV) * 255).astype(np.uint8))))
# 整枚币的斜向镜面高光
sheen = np.exp(-(((xx - yy) + 520) / 330) ** 2) * 0.22 + np.exp(-(((xx - yy) - 900) / 160) ** 2) * 0.08
sh = Image.new("RGBA", (S, S), (255, 255, 250, 0)); sh.putalpha(Image.fromarray((sheen * (r <= R_EDGE) * 255).clip(0, 255).astype(np.uint8)))
coin.alpha_composite(sh)
# 落地阴影
out = Image.new("RGBA", (S + 200, S + 200), (0, 0, 0, 0))
ds = Image.new("RGBA", (S, S), (40, 24, 4, 0)); ds.putalpha(alpha.filter(ImageFilter.GaussianBlur(28)).point(lambda v: int(v * 0.45)))
out.alpha_composite(ds, (130, 150)); out.alpha_composite(coin, (100, 100))
out = out.resize((1300, 1300), Image.LANCZOS)
out.save(sys.argv[3]); out.resize((256, 256), Image.LANCZOS).save(sys.argv[3].replace(".png", "-256.png"))
print("saved", sys.argv[3])
