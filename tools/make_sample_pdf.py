# -*- coding: utf-8 -*-
"""生成最小合法 PDF（两页、真实文本、Helvetica 标准字体），供阅伴示例库使用。"""

OUT = r"sample-files\transformer-survey.pdf"


def esc(s: str) -> str:
    return s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def make_pdf(pages: list[list[tuple[float, float, int, str]]]) -> bytes:
    """pages: 每页为 (x, y, size, text) 流指令列表"""
    objs: list[bytes] = []
    n_pages = len(pages)

    # 1: Catalog, 2: Pages, 3..: Font, Page, Content 交错
    font_id = 3
    page_ids = [3 + 1 + 2 * i for i in range(n_pages)]  # 每页占 Page+Content 两个对象
    kids = " ".join(f"{pid} 0 R" for pid in page_ids)

    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")                       # 1
    objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>".encode())  # 2
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")  # 3

    for i, ops in enumerate(pages):
        pid = page_ids[i]
        cid = pid + 1
        objs.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {cid} 0 R >>".encode()
        )
        stream = "BT\n" + "".join(f"/F1 {size} Tf 1 0 0 1 {x} {y} Tm ({esc(t)}) Tj\n" for x, y, size, t in ops) + "ET"
        objs.append(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream".encode())

    # 组装带 xref 的完整 PDF
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref_pos = len(out)
    out += f"xref\n0 {len(objs) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF".encode()
    return bytes(out)


page1 = [
    (60, 780, 20, "Transformer: A Survey of Self-Attention Architectures"),
    (60, 758, 10, "Vaswani et al. - Sample Document for Yueban Reader"),
    (60, 720, 13, "Abstract"),
    (60, 700, 11, "The Transformer architecture abandons recurrence entirely, relying on"),
    (60, 686, 11, "multi-head self-attention to model sequence dependencies. It achieves"),
    (60, 672, 11, "state-of-the-art results in translation, summarization and generation."),
    (60, 630, 13, "1. Introduction"),
    (60, 610, 11, "Self-attention allows each position to attend to all other positions in"),
    (60, 596, 11, "the sequence directly. This brings a leap in long-range dependency"),
    (60, 582, 11, "modeling, but also introduces higher memory cost: the complexity of"),
    (60, 568, 11, "attention is O(n^2) with respect to sequence length."),
    (60, 526, 11, "The core innovations are multi-head attention and positional encoding:"),
    (60, 512, 11, "parallel heads capture information in different subspaces, while"),
    (60, 498, 11, "positional encoding injects order information into the sequence."),
    (60, 456, 13, "2. Architecture"),
    (60, 436, 11, "Component          Role                        Complexity"),
    (60, 422, 11, "Multi-head attn    diverse dependencies         O(n^2)"),
    (60, 408, 11, "Feed-forward       non-linear transform         O(n)"),
    (60, 394, 11, "Residual link      stable gradient flow         O(n)"),
]

page2 = [
    (60, 780, 14, "3. Scaled Dot-Product Attention"),
    (60, 758, 11, "The scaling factor sqrt(d) prevents the dot products from growing"),
    (60, 744, 11, "too large, which would push softmax into regions of vanishing"),
    (60, 730, 11, "gradient. Experiments show scaled dot-product attention outperforms"),
    (60, 716, 11, "additive attention on large models."),
    (60, 674, 13, "4. Conclusion"),
    (60, 654, 11, "The Transformer has been widely adopted in NLP, multimodal and code"),
    (60, 640, 11, "generation. Its high training parallelism makes it easy to scale to"),
    (60, 626, 11, "very large pre-training stages."),
    (60, 120, 10, "- 1 -"),
]

pdf = make_pdf([page1, page2])
with open(OUT, "wb") as f:
    f.write(pdf)
print(f"OK: {OUT} ({len(pdf)} bytes)")
