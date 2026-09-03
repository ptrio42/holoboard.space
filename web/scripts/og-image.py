"""Draws the image social networks show when somebody shares the board.

Run it when the tagline changes, or the wordmark, and commit what it writes.
It needs the display face as a TrueType file, which the app itself ships only
as woff2 because that is what a browser wants:

    curl -sLo /tmp/PressStart2P.ttf \
      https://github.com/google/fonts/raw/main/ofl/pressstart2p/PressStart2P-Regular.ttf
    python3 web/scripts/og-image.py --font /tmp/PressStart2P.ttf

Sized 1200x630, which is what the crawlers ask for, and drawn to survive being
shown at a fifth of that: a preview card is small and usually beside a headline,
so the wordmark carries it and everything else stays out of the way.
"""

import argparse
from PIL import Image, ImageDraw, ImageFilter, ImageFont

WIDTH, HEIGHT = 1200, 630

VOID = (5, 1, 13)
CYAN = (34, 211, 238)
PINK = (236, 72, 153)
GOLD = (251, 191, 36)

TAGLINE = "Lit with sats"
DOMAIN = "holoboard.space"


def glow(size, draw_on_layer, colour, radius):
    """A blurred copy underneath, which is how the site gets its neon."""
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    draw_on_layer(ImageDraw.Draw(layer))
    return layer.filter(ImageFilter.GaussianBlur(radius)), layer


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--font", required=True, help="PressStart2P-Regular.ttf")
    parser.add_argument("--out", default="web/public/og.png")
    args = parser.parse_args()

    wordmark = ImageFont.truetype(args.font, 76)
    body = ImageFont.truetype(args.font, 32)
    small = ImageFont.truetype(args.font, 17)

    image = Image.new("RGB", (WIDTH, HEIGHT), VOID)
    draw = ImageDraw.Draw(image)

    # A grid, barely there. It reads as texture rather than as lines.
    for x in range(0, WIDTH, 40):
        draw.line([(x, 0), (x, HEIGHT)], fill=(12, 8, 28), width=1)
    for y in range(0, HEIGHT, 40):
        draw.line([(0, y), (WIDTH, y)], fill=(12, 8, 28), width=1)

    def centred(text, font):
        left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
        return (WIDTH - (right - left)) // 2 - left, top, bottom

    wx, _, _ = centred("HOLOBOARD", wordmark)
    wy = 238

    blurred, sharp = glow(
        (WIDTH, HEIGHT),
        lambda d: d.text((wx, wy), "HOLOBOARD", font=wordmark, fill=PINK + (255,)),
        PINK,
        18,
    )
    image = Image.alpha_composite(image.convert("RGBA"), blurred)
    image = Image.alpha_composite(image, sharp).convert("RGB")
    draw = ImageDraw.Draw(image)

    tx, _, _ = centred(TAGLINE, body)
    draw.text((tx, wy + 132), TAGLINE, font=body, fill=(150, 220, 235))

    dx, _, _ = centred(DOMAIN, small)
    draw.text((dx, HEIGHT - 112), DOMAIN, font=small, fill=GOLD)

    # A rule under the wordmark, in the cyan the board uses for its frames.
    draw.rectangle([(WIDTH // 2 - 190, wy + 108), (WIDTH // 2 + 190, wy + 110)], fill=(34, 211, 238))

    image.save(args.out, optimize=True)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
