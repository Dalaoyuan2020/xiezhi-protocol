"""把 AIA_COMMUNITY_WHITEPAPER.md 渲染成打印用 HTML（再用 Chrome 打印成 PDF）。
用法：python3 whitepaper/build_html.py whitepaper/AIA_COMMUNITY_WHITEPAPER.md /tmp/aia.html   （需要 pip 包 markdown）"""
import markdown, sys, os
src, out = sys.argv[1], sys.argv[2]
base = os.path.dirname(os.path.abspath(src))
md = open(src, encoding="utf-8").read()
html = markdown.markdown(md, extensions=["tables", "fenced_code", "md_in_html"])
html = html.replace('src="../brand/', f'src="file://{os.path.dirname(base)}/brand/').replace('src="figures/', f'src="file://{base}/figures/')
# 封面独占一页
cut = html.index("<hr")
# 封面底部：署名 + 参赛信息 + logo 一排（figures/logos/ 里有图就用图，没有就用文字）
LOGOS = [("hankesong", "汉客松 S1"), ("gcc", "GCC"), ("botchain", "BOT Chain"), ("hai", "h.ai 学社")]
def logo_cell(key, text):
    for ext in ("png", "svg", "jpg"):
        f = os.path.join(base, "figures", "logos", f"{key}.{ext}")
        if os.path.exists(f):
            return f'<div class="logo"><img src="file://{f}" alt="{text}"></div>'
    return f'<div class="logo"><b>{text}</b></div>'
foot = ('<div class="cover-foot"><p class="byline">Know &amp; Act（知行合一）</p>'
        '<p class="event">参赛作品 · 汉客松 S1 · ETH Wuhan 2026 · AI × Blockchain Hackathon</p>'
        '<div class="logos">' + "".join(logo_cell(*x) for x in LOGOS) + '</div></div>')
html = f'<section class="cover">{html[:cut]}<p class="cover-coin"><img src="file://{os.path.dirname(base)}/brand/zhidian-coin.png" width="110"></p>{foot}</section>' + html[cut:]
css = """
@page{size:A4;margin:20mm 18mm 20mm 18mm}
:root{--red:#b8292f;--ink:#26221f;--muted:#6b645d;--line:#e2ddd5;--soft:#f6f4f0}
body{font-family:"PingFang SC","Hiragino Sans GB",sans-serif;color:var(--ink);font-size:10.5pt;line-height:1.72;background:#fff;margin:0}
.cover{height:255mm;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;break-after:page}
.cover h1{font-family:"Songti SC",serif;font-size:34pt;letter-spacing:.12em;margin:8mm 0 4mm;border:0}
.cover p{font-size:12pt;line-height:1.9;color:var(--muted)} .cover p b{color:var(--ink);font-size:15pt}
.cover-coin{margin-top:8mm}
.cover-foot{margin-top:14mm;width:100%;border-top:1px solid var(--line);padding-top:6mm}
.cover .byline{font-family:"Songti SC",serif;font-size:16pt;color:var(--ink);margin:0 0 1mm;letter-spacing:.08em}
.cover .event{font-size:10pt;color:var(--muted);margin:0 0 5mm}
.logos{display:flex;justify-content:center;align-items:center;gap:9mm;flex-wrap:wrap;max-width:170mm;margin:0 auto}
.logo{display:flex;flex-direction:column;align-items:center;gap:2mm}
.logo img{height:9mm;width:auto;max-width:38mm;object-fit:contain}
.logo b{font-size:12pt;color:var(--ink);height:12mm;display:flex;align-items:center}
.logo span{font-size:8pt;color:var(--muted)}
h1{font-family:"Songti SC",serif}
h2{font-family:"Songti SC",serif;font-size:17pt;color:var(--ink);border-left:5px solid var(--red);padding:2px 0 2px 10px;margin:9mm 0 4mm;break-after:avoid}
.pb{break-before:page;height:0}
h3{font-size:12pt;margin:6mm 0 2mm;break-after:avoid;color:var(--ink)}
p{margin:2mm 0}
table{border-collapse:collapse;width:100%;margin:3mm 0;font-size:9.4pt;break-inside:avoid}
th{background:var(--soft);font-weight:600;color:var(--ink)}
th,td{border:1px solid var(--line);padding:5px 8px;vertical-align:top;text-align:left}
code{font-family:Menlo,monospace;font-size:8.6pt;background:var(--soft);padding:1px 4px;border-radius:3px}
pre{background:var(--soft);border:1px solid var(--line);border-radius:6px;padding:10px 12px;font-size:8.6pt;line-height:1.5;break-inside:avoid;white-space:pre-wrap}
pre code{background:none;padding:0}
blockquote{margin:3mm 0;padding:6px 14px;border-left:3px solid var(--red);background:#faf6f3;color:var(--ink)}
hr{border:0;border-top:1px solid var(--line);margin:6mm 0}
a{color:var(--red);text-decoration:none}
p[align=center]{text-align:center;break-inside:avoid;margin:5mm 0}
p[align=center] img{max-width:100%;height:auto;border-radius:4px}
p[align=center] img[src$=".jpg"]{border:1px solid var(--line);box-shadow:0 2px 8px rgba(0,0,0,.06)}
sub{display:block;margin-top:2mm;font-size:8.8pt;color:var(--muted);vertical-align:baseline}
strong{color:var(--ink)}
"""
open(out, "w", encoding="utf-8").write(f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>AIA 社区白皮书</title><style>{css}</style></head><body>{html}</body></html>')
print("html ok")
