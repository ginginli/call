# -*- coding: utf-8 -*-
"""生成 Win7 用户安装操作流程的 6 张步骤图 (PNG)"""
from PIL import Image, ImageDraw, ImageFont
import os

OUT = os.path.join(os.path.dirname(__file__), 'images')
os.makedirs(OUT, exist_ok=True)

W, H = 1200, 800
BLUE   = (43, 108, 176)
LIGHT  = (235, 244, 252)
ORANGE = (221, 107, 32)
GREEN  = (56, 161, 105)
DARK   = (45, 55, 72)
GRAY   = (113, 128, 150)

FONT_PATH = "/System/Library/Fonts/STHeiti Light.ttc"

def font(sz):
    return ImageFont.truetype(FONT_PATH, sz)

def new_canvas():
    img = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 10], fill=BLUE)
    return img, d

def header(d, step, title):
    d.ellipse([60, 55, 170, 165], fill=BLUE)
    f = font(64)
    t = str(step)
    tw = d.textlength(t, font=f)
    d.text((115 - tw/2, 68), t, fill='white', font=f)
    d.text((200, 75), title, fill=DARK, font=font(52))
    d.line([60, 200, W-60, 200], fill=(226, 232, 240), width=3)

def footer(d, lines, y0=620):
    f = font(30)
    y = y0
    for ln in lines:
        d.text((90, y), "· " + ln, fill=DARK, font=f)
        y += 52

def browser_window(d, x, y, w, h, title="https://github.com/ginginli/call/actions"):
    d.rounded_rectangle([x, y, x+w, y+h], 16, fill='white', outline=GRAY, width=3)
    d.rounded_rectangle([x, y, x+w, y+52], 16, fill=(237, 242, 247))
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([x+20+i*30, y+16, x+40+i*30, y+36], fill=c)
    d.text((x+120, y+10), title, fill=GRAY, font=font(24))

def folder(d, x, y, w, h, color=ORANGE):
    d.rounded_rectangle([x, y+30, x+w, y+h], 8, fill=color)
    d.rounded_rectangle([x, y, x+w*0.45, y+40], 8, fill=color)

# ---------------------------------------------------------------- step 1
img, d = new_canvas()
header(d, 1, "在电脑上下载两个压缩包")
browser_window(d, 120, 240, 960, 330)
d.text((160, 330), "Artifacts 下载区 (页面拉到最底部)", fill=GRAY, font=font(28))
for i, (name, sz, c) in enumerate([
    ("class-call-screen-win7-x64.zip   (程序本体)", 58, ORANGE),
    ("class-call-screen-win7-deps.zip   (依赖包)",  87, BLUE)]):
    y = 390 + i * 85
    d.rounded_rectangle([160, y, 1050, y+68], 10, fill=LIGHT, outline=c, width=3)
    d.text((185, y+16), name, fill=c, font=font(30))
    d.rounded_rectangle([830, y+20, 1020, y+48], 14, fill=c)
    d.text((845, y+22), "点击 Download", fill='white', font=font(22))
footer(d, ["打开链接: github.com/ginginli/call/actions → 点最新一次绿色 ✓ 的运行",
           "页面拉到最底部 Artifacts 区, 下载上面两个 zip (共约 150 MB)",
           "Win10/11 用户只需下载 class-call-screen-latest-x64 即可"])
img.save(f'{OUT}/step1.png')

# ---------------------------------------------------------------- step 2
img, d = new_canvas()
header(d, 2, "解压并拷贝到 U 盘")
folder(d, 130, 270, 300, 220)
d.text((150, 520), "win7-deps 解压后", fill=GRAY, font=font(26))
for i, t in enumerate(["install.bat", "vc_redist.x64.exe", "3 个补丁 .msu", "README.txt"]):
    d.text((150, 320+i*42), t, fill='white', font=font(26))
folder(d, 500, 270, 300, 220, BLUE)
d.text((520, 520), "win7-x64 解压后", fill=GRAY, font=font(26))
d.text((520, 320), "班级喊话演示屏", fill='white', font=font(26))
d.text((520, 362), "1.0.0.exe", fill='white', font=font(26))
# U 盘
ux, uy = 920, 300
d.rounded_rectangle([ux, uy, ux+130, uy+160], 12, fill=(160, 174, 192))
d.rectangle([ux+30, uy-60, ux+100, uy+4], fill=GRAY)
d.text((870, 500), "U 盘", fill=GRAY, font=font(30))
d.line([(450, 380), (890, 380)], fill=GREEN, width=6)
d.polygon([(890, 380), (860, 365), (860, 395)], fill=GREEN)
footer(d, ["两个 zip 都解压 (右键 → 全部解压缩)",
           "把解压出来的两个文件夹整体拷进 U 盘",
           "注意: win7-x64 解压后是整个文件夹, 不要只拷 exe 单个文件"])
img.save(f'{OUT}/step2.png')

# ---------------------------------------------------------------- step 3
img, d = new_canvas()
header(d, 3, "在 Win7 电脑上打开依赖文件夹")
folder(d, 140, 260, 340, 240, ORANGE)
d.text((170, 330), "win7-deps", fill='white', font=font(34))
# 桌面
dx, dy = 700, 250
d.rounded_rectangle([dx, dy, dx+380, dy+300], 12, fill=(43, 87, 151))
d.rounded_rectangle([dx, dy, dx+380, dy+40], 12, fill=(30, 64, 113))
folder(d, dx+30, dy+80, 130, 100, ORANGE)
folder(d, dx+210, dy+80, 130, 100, BLUE)
d.text((dx+52, dy+230), "win7-deps", fill='white', font=font(24))
d.text((dx+235, dy+230), "win7-x64", fill='white', font=font(24))
d.line([(560, 380), (690, 380)], fill=GREEN, width=6)
d.polygon([(690, 380), (660, 365), (660, 395)], fill=GREEN)
footer(d, ["U 盘插到 Win7 电脑的 USB 口",
           "打开 U 盘, 能看到两个文件夹",
           "先进入 win7-deps 文件夹 (里面有 install.bat)"])
img.save(f'{OUT}/step3.png')

# ---------------------------------------------------------------- step 4
img, d = new_canvas()
header(d, 4, "右键以管理员身份运行 install.bat")
d.text((150, 250), "在 win7-deps 文件夹里, 找到 install.bat:", fill=DARK, font=font(34))
d.rounded_rectangle([150, 320, 560, 400], 10, fill=LIGHT, outline=GRAY, width=3)
d.text((185, 335), "install.bat", fill=DARK, font=font(34))
# 右键菜单
mx, my = 620, 280
d.rounded_rectangle([mx, my, mx+420, my+330], 8, fill='white', outline=GRAY, width=3)
items = ["打开(O)", "编辑(E)", "───────", "以管理员身份运行(A)", "属性(R)"]
for i, t in enumerate(items):
    y = my + 18 + i * 62
    hl = (t.startswith("以管理员"))
    if hl:
        d.rectangle([mx+8, y-8, mx+412, y+52], fill=BLUE)
    d.text((mx+40, y), t, fill='white' if hl else DARK, font=font(30))
d.polygon([(610, 340), (650, 340), (630, 370)], fill=DARK)
footer(d, ["右键点击 install.bat → 选\"以管理员身份运行\"",
           "如果弹出\"用户账户控制\"询问框, 点\"是\"",
           "然后会出现黑色命令行窗口开始安装"], y0=650)
img.save(f'{OUT}/step4.png')

# ---------------------------------------------------------------- step 5
img, d = new_canvas()
header(d, 5, "等待安装完成并重启")
d.text((150, 260), "命令行窗口会依次显示 4 个步骤:", fill=DARK, font=font(34))
steps5 = [("1/4  VC++ 2015-2022 运行库", ORANGE), ("2/4  KB4490628 系统更新", BLUE),
          ("3/4  KB4474419 SHA-2 补丁", BLUE), ("4/4  KB3140245 补丁", BLUE)]
for i, (t, c) in enumerate(steps5):
    y = 330 + i * 62
    d.rounded_rectangle([150, y, 700, y+50], 25, fill=c)
    d.text((175, y+8), "✓ " + t, fill='white', font=font(28))
# 进度条
d.rounded_rectangle([760, 360, 1080, 392], 16, fill=(226, 232, 240))
d.rounded_rectangle([760, 360, 1080, 392], 16, fill=GREEN)
d.text((760, 410), "安装完成 100%", fill=GREEN, font=font(28))
# 重启图标
d.ellipse([850, 470, 990, 610], outline=GREEN, width=12)
d.polygon([(990, 470), (990, 540), (920, 540)], fill=GREEN)
d.text((855, 620), "10 秒后自动重启", fill=GREEN, font=font(28))
footer(d, ["全程约 5 分钟, 大部分时间在装 KB4474419, 请耐心等待",
           "看到提示后电脑会在 10 秒后自动重启 (也可手动立即重启)",
           "★ 不要在安装中途关机或拔 U 盘"], y0=680)
img.save(f'{OUT}/step5.png')

# ---------------------------------------------------------------- step 6
img, d = new_canvas()
header(d, 6, "重启后双击程序启动")
# Win7 桌面
dx, dy = 130, 250
d.rounded_rectangle([dx, dy, dx+560, dy+360], 12, fill=(43, 87, 151))
d.rounded_rectangle([dx, dy, dx+560, dy+44], 12, fill=(30, 64, 113))
# 图标
d.rounded_rectangle([dx+60, dy+90, dx+170, dy+200], 12, fill=ORANGE)
d.text((dx+80, dy+120), "喊话", fill='white', font=font(30))
d.text((dx+50, dy+220), "班级喊话演示屏", fill='white', font=font(24))
d.text((dx+78, dy+252), "1.0.0.exe", fill='white', font=font(22))
# 双击光标
d.polygon([(dx+180, dy+150), (dx+230, dy+165), (dx+195, dy+180)], fill='yellow')
# 程序窗口
wx, wy = 760, 270
d.rounded_rectangle([wx, wy, wx+340, wy+330], 12, fill='white', outline=GRAY, width=4)
d.rounded_rectangle([wx, wy, wx+340, wy+46], 12, fill=BLUE)
d.text((wx+15, wy+8), "班级喊话演示屏", fill='white', font=font(26))
d.rounded_rectangle([wx+30, wy+80, wx+310, wy+150], 8, fill=LIGHT)
d.text((wx+50, wy+95), "大字标语滚动显示...", fill=BLUE, font=font(26))
d.rounded_rectangle([wx+30, wy+180, wx+310, wy+250], 8, fill=(254, 235, 200))
d.text((wx+50, wy+195), "全屏演示模式", fill=ORANGE, font=font(26))
footer(d, ["进入 U 盘的 win7-x64 文件夹, 双击\"班级喊话演示屏 1.0.0.exe\"",
           "程序是绿色免安装版, 直接运行即可",
           "建议右键 exe → 发送到 → 桌面快捷方式, 方便下次打开"], y0=650)
img.save(f'{OUT}/step6.png')

print("OK ->", OUT)
for f in sorted(os.listdir(OUT)):
    if f.endswith('.png'):
        print(" ", f)
