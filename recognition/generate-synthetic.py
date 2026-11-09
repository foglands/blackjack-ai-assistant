"""Render a local blackjack vision fixture using original, procedural card faces."""

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


FPS = 25
FELT = "#163b36"
SUITS = "♠♥♣♦"
DEALS = (
    ((1, 3, 5, 7), ("2", "3", "4", "5", "K"), ("6", "7", "8", "9"),
     ((1, "Q"),), ("7",)),
    ((2, 4, 7), ("10", "J", "Q", "A"), ("K", "2", "3"),
     ((4, "6"), (7, "10")), ("4", "8", "9")),
    ((1, 2, 4, 6), ("A", "5", "9", "J", "6"), ("4", "K", "8", "2"),
     ((1, "8"), (6, "7")), ("9", "2")),
)


def load_geometry(project, node):
    expression = """
const replay = require('./dist/recognition-profile.js');
const live = require('./dist/live-recognition-profile.js').fromReplay(replay);
console.log(JSON.stringify({ width: live.width, height: live.height, slots: live.slots }));
"""
    profile = json.loads(subprocess.check_output([node, "-e", expression], cwd=project))
    slots = {(slot["seat"], slot["slot"]): slot for slot in profile["slots"]}
    for index in (3, 4):
        slots[0, index] = {**slots[0, 2], "x": 1170 + (index - 2) * 51}
    return (profile["width"], profile["height"]), slots


def font(size, bold=False):
    filename = "arialbd.ttf" if bold else "arial.ttf"
    return ImageFont.truetype(filename, size)


def background(size, slots, round_number, occupied):
    image = Image.new("RGB", size, "#101b21")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((390, 355, 1938, 1238), radius=210, fill="#293330", outline="#826c4e", width=4)
    draw.rounded_rectangle((407, 371, 1921, 1221), radius=195, fill=FELT, outline="#536d5e", width=2)
    draw.arc((575, 430, 1752, 1110), 0, 180, fill="#50736a", width=2)
    draw.text((420, 108), "BLACKJACK", font=font(55, True), fill="#eee7d7")
    draw.text((423, 178), "SYNTHETIC TEST TABLE", font=font(22, True), fill="#8db2a3")
    draw.text((1905, 149), f"ROUND 0{round_number}", font=font(30, True), fill="#e2c587", anchor="ra")
    draw.text((size[0] // 2, 737), "DEALER", font=font(19, True), fill="#bacbbf", anchor="mm")
    for seat in range(1, 8):
        slot = slots[seat, 1]
        x, y = slot["x"], slot["y"] + 115
        active = seat in occupied
        fill = "#e4ca91" if active else "#718a80"
        draw.ellipse((x - 22, y - 22, x + 22, y + 22), fill="#18302e", outline=fill, width=2)
        draw.text((x, y + 1), str(seat), fill=fill, font=font(22, True), anchor="mm")
        draw.text((x, y + 38), "IN PLAY" if active else "EMPTY", font=font(13, True), fill=fill, anchor="mm")
    return image


def card_art(rank, suit, slot, index_only=False):
    width, height = 53, 65
    center_x, center_y = 23, 16
    card = Image.new("RGBA", (width, height))
    draw = ImageDraw.Draw(card)
    if not index_only:
        draw.rounded_rectangle((0, 0, width - 1, height - 1), radius=4, fill="#f6f1e6", outline="#e0dbce")
    if rank:
        ink = "#b52739" if suit in "♥♦" else "#181b20"
        if index_only:
            # Keep index corners readable where the profile has close, fanned cards.
            maximum = 18 if slot["seat"] == 1 else 23
            label = font(min(maximum, slot["h"] - 1), True)
            point = center_x, center_y
            left, top, right, bottom = draw.textbbox(point, rank, font=label, anchor="mm")
            draw.rectangle((left - 2, top - 1, right + 2, bottom), fill="#f6f1e6")
            draw.text(point, rank, font=label, fill=ink, anchor="mm")
        else:
            draw.text((center_x + 3, 42), suit, font=font(24), fill=ink, anchor="mm")
    else:
        draw.rounded_rectangle((3, 3, width - 4, height - 4), radius=3, fill="#274563")
        for y in range(10, height - 7, 8):
            for x in range(8, width - 7, 8):
                draw.point((x, y), fill="#a9b5bf")

    # Invert the profile's crop shear to render a corner at its actual ROI.
    u, v = slot["u"], slot["v"]
    corners = [(x - center_x, y - center_y) for x in (0, width) for y in (0, height)]
    left = int(min(x + v * y for x, y in corners)) - 2
    top = int(min(u * x + y for x, y in corners)) - 2
    right = int(max(x + v * y for x, y in corners)) + 2
    bottom = int(max(u * x + y for x, y in corners)) + 2
    inv = 1 / (1 - u * v)
    mapped = card.transform((right - left, bottom - top), Image.Transform.AFFINE,
                            (inv, -v * inv, center_x + (left - v * top) * inv,
                             -u * inv, inv, center_y + (top - u * left) * inv),
                            Image.Resampling.BICUBIC)
    return mapped, (slot["x"] + left, slot["y"] + top)


def render(destination, ffmpeg, node):
    size, slots = load_geometry(Path(__file__).resolve().parents[1], node)
    truth = {
        "source": "Original procedural artwork. No online deck, casino footage or screenshots used.",
        "seatNumbering": "Dealer is 0. Seat 1 is screen right and seat 7 is screen left.",
        "timeBasis": "First visible frame. Frame numbers are zero-based at a constant 25 fps.",
        "geometry": {"width": size[0], "height": size[1], "reference": "Local live-recognition profile"},
        "rounds": [],
        "events": [],
    }
    frame_index = 0
    manifest = ["ffconcat version 1.0"]
    with tempfile.TemporaryDirectory(prefix=".synthetic-frames-", dir=destination) as temporary:
        working = Path(temporary)

        def hold(frames):
            nonlocal frame_index, last_image
            frame = table.copy()
            spread = sorted(hands.items(), reverse=True)
            for index_only in (False, True):
                for (seat, position), (rank, suit) in spread:
                    if index_only and not rank:
                        continue
                    image, point = card_art(rank, suit, slots[seat, position], index_only)
                    frame.paste(image, point, image)
            last_image = f"frame-{frame_index:04d}.png"
            frame.save(working / last_image, compress_level=1)
            manifest.extend((f"file '{last_image}'", f"duration {frames / FPS:.2f}"))
            frame_index += frames

        def deal(seat, rank, stage, position=None, frames=14):
            if position is None:
                position = 1 + sum(s == seat for s, _ in hands)
            suit = SUITS[len(truth["events"]) % len(SUITS)]
            hands[seat, position] = rank, suit
            if rank:
                slot = slots[seat, position]
                truth["events"].append({"round": round_number, "seat": seat, "slot": position,
                                        "rank": rank, "suit": suit, "stage": stage,
                                        "frame": frame_index, "time": frame_index / FPS,
                                        "x": slot["x"], "y": slot["y"]})
            else:
                round_info["holeDealtFrame"] = frame_index
            hold(frames)

        last_image = None
        for round_number, (occupied, first, second, hits, dealer_draw) in enumerate(DEALS, 1):
            round_info = {"round": round_number, "occupied": occupied,
                          "empty": [seat for seat in range(1, 8) if seat not in occupied],
                          "startFrame": frame_index}
            truth["rounds"].append(round_info)
            table = background(size, slots, round_number, occupied)
            hands = {}
            hold(22)
            for seat, rank in zip((*occupied, 0), first, strict=True):
                deal(seat, rank, "initial")
            for seat, rank in zip(occupied, second, strict=True):
                deal(seat, rank, "initial")
            deal(0, None, "hole-dealt", frames=26)
            for seat, rank in hits:
                deal(seat, rank, "hit", frames=19)
            deal(0, dealer_draw[0], "reveal", position=2, frames=19)
            for rank in dealer_draw[1:]:
                deal(0, rank, "dealer-hit", frames=19)
            hold(28)

        manifest.append(f"file '{last_image}'")
        (working / "frames.ffconcat").write_text("\n".join(manifest) + "\n", encoding="ascii")
        subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat",
                        "-i", str(working / "frames.ffconcat"), "-vf", f"fps={FPS}",
                        "-frames:v", str(frame_index), "-an", "-c:v", "libvpx-vp9", "-deadline", "good",
                        "-cpu-used", "5", "-row-mt", "1", "-b:v", "0", "-crf", "18", "-pix_fmt", "yuv420p",
                        str(destination / "synthetic-seven-seat.webm")], check=True)

    truth["fps"] = FPS
    truth["frames"] = frame_index
    truth["duration"] = frame_index / FPS
    (destination / "synthetic-seven-seat-truth.json").write_text(
        json.dumps(truth, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    render(Path(__file__).resolve().parent, args.ffmpeg, args.node)
