"""Generate favicon and app icons from the shared pixel H. Requires Pillow."""

import argparse
from copy import deepcopy
from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw

WEB = Path(__file__).resolve().parents[1]
VOID = "#05010d"
SVG = "http://www.w3.org/2000/svg"


def render(mark, size, fraction=0.875, transparent=False):
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0) if transparent else VOID)
    draw = ImageDraw.Draw(image)
    extent = size * fraction
    offset = (size - extent) / 2
    scale = extent / 7
    for rectangle in mark:
        x = float(rectangle.get("x", 0))
        y = float(rectangle.get("y", 0))
        width = float(rectangle.attrib["width"])
        height = float(rectangle.attrib["height"])
        draw.rectangle((round(offset + x * scale), round(offset + y * scale),
                        round(offset + (x + width) * scale) - 1,
                        round(offset + (y + height) * scale) - 1),
                       fill=rectangle.get("fill", mark.attrib["fill"]))
    return image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--android", action="store_true", help="Also refresh checked-in Android icons and splash images")
    args = parser.parse_args()
    mark = ET.parse(WEB / "src/assets/holoboard-mark.svg").getroot()
    if mark.attrib["viewBox"] != "0 0 7 7" or any(child.tag != f"{{{SVG}}}rect" for child in mark):
        raise ValueError("Expected the shared 7 by 7 rectangular pixel mark")
    ET.register_namespace("", SVG)
    favicon = ET.Element(f"{{{SVG}}}svg", {"viewBox": "0 0 16 16", "shape-rendering": "crispEdges"})
    ET.SubElement(favicon, f"{{{SVG}}}rect", {"width": "16", "height": "16", "fill": VOID})
    glyph = ET.SubElement(favicon, f"{{{SVG}}}g", {"fill": mark.attrib["fill"], "transform": "translate(1 1) scale(2)"})
    glyph.extend(deepcopy(list(mark)))
    ET.indent(favicon, space="  ")
    (WEB / "public/favicon.svg").write_text(ET.tostring(favicon, encoding="unicode") + "\n")
    for name, size, fraction in [("pwa-192x192.png", 192, 0.875),
                                 ("pwa-512x512.png", 512, 0.875),
                                 ("pwa-maskable-512x512.png", 512, 0.546875),
                                 ("apple-touch-icon.png", 180, 0.875)]:
        render(mark, size, fraction).save(WEB / "public/icons" / name, optimize=True)
    if args.android:
        android = WEB.parent / "android"
        resources = android / "app/src/main/res"
        for directory in resources.glob("mipmap-*"):
            for name, fraction in [("ic_launcher.png", 0.625), ("ic_maskable.png", 0.546875)]:
                path = directory / name
                if path.is_file():
                    with Image.open(path) as current:
                        size = current.width
                    render(mark, size, fraction).save(path, optimize=True)
        for path in resources.glob("drawable-*/splash.png"):
            with Image.open(path) as current:
                size = current.width
            render(mark, size, 0.875, transparent=True).save(path, optimize=True)
        render(mark, 512).save(android / "store_icon.png", optimize=True)


if __name__ == "__main__":
    main()
