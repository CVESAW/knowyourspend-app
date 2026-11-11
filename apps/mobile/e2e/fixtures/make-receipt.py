"""
Draws the made-up receipt photo used by the receipt-reading step of e2e/smoke.mjs (made-up shop details,
not a real store's). Needs Pillow and the DejaVu fonts:

    python3 e2e/fixtures/make-receipt.py e2e/fixtures/receipt-tesco.jpg
"""
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

out = sys.argv[1]
W, H = 687, 898
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONO_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
f = ImageFont.truetype(MONO, 24)
fb = ImageFont.truetype(MONO_B, 24)
ft = ImageFont.truetype(MONO_B, 36)

# background: a brown table, a little darker at the edges
bg = Image.new("RGB", (W, H), (112, 82, 52))
shade = Image.new("L", (W, H), 0)
ds = ImageDraw.Draw(shade)
for i in range(60):
    ds.rectangle([i * 3, i * 3, W - i * 3, H - i * 3], outline=int(60 - i))
bg = Image.composite(Image.new("RGB", (W, H), (92, 66, 40)), bg, shade.filter(ImageFilter.GaussianBlur(30)))

RW, RH = 545, 735
paper = Image.new("RGBA", (RW, RH), (246, 246, 244, 255))
d = ImageDraw.Draw(paper)
ink = (38, 38, 38, 255)

def centre(y, text, font):
    w = d.textlength(text, font=font)
    d.text(((RW - w) / 2, y), text, font=font, fill=ink)

def row(y, left, right, font=f):
    d.text((40, y), left, font=font, fill=ink)
    w = d.textlength(right, font=font)
    d.text((505 - w, y), right, font=font, fill=ink)

centre(38, "TESCO", ft)
centre(92, "Leeds Superstore", f)
centre(124, "Tel 0113 000 0000", f)
centre(156, "VAT No GB 220 4302 31", f)
items = [
    ("TESCO SEMI SKIMMED 4PT", "£1.65"),
    ("COCA COLA ZERO 2L", "£2.15"),
    ("HEINZ BEANZ 4X415G", "£3.20"),
    ("CADBURY DAIRY MILK 180G", "£2.50"),
    ("WALKERS CRISPS 6PK", "£1.85"),
    ("TESCO BANANAS LOOSE", "£0.92"),
    ("PG TIPS 80S", "£2.75"),
    ("LURPAK SPREADABLE 500G", "£4.50"),
]
y = 222
for name, price in items:
    row(y, name, price)
    y += 32
d.text((40, y + 2), "-" * 33, font=f, fill=ink)
row(y + 32, "8 BALANCE DUE", "£19.52", fb)
row(y + 64, "VISA CONTACTLESS", "£19.52")
centre(y + 128, "CLUBCARD POINTS THIS VISIT 23", f)
centre(y + 160, "11/03/2026  14:41  ST:2381 OP:112", f)
centre(y + 192, "THANK YOU FOR SHOPPING", f)

# soft light falloff across the paper
grad = Image.new("L", (RW, RH))
gd = ImageDraw.Draw(grad)
for x in range(RW):
    gd.line([(x, 0), (x, RH)], fill=int(14 * x / RW))
paper = Image.composite(Image.new("RGBA", (RW, RH), (226, 226, 224, 255)), paper, grad)

angle = 2.4
rot = paper.rotate(angle, resample=Image.BICUBIC, expand=True)
ox, oy = (W - rot.width) // 2 + 6, (H - rot.height) // 2 - 6
shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
mask = rot.split()[3].point(lambda a: int(a * 0.45))
shadow.paste((20, 12, 4, 255), (ox + 8, oy + 10), mask)
shadow = shadow.filter(ImageFilter.GaussianBlur(10))
img = bg.convert("RGBA")
img = Image.alpha_composite(img, shadow)
img.paste(rot, (ox, oy), rot)
img = img.convert("RGB").filter(ImageFilter.GaussianBlur(0.6))
img.save(out, "JPEG", quality=88)
print("wrote", out, img.size)
