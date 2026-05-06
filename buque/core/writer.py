from __future__ import annotations

from pathlib import Path

import fitz

from buque.core.models import TocNode


def write_bookmarks(input_path: Path, output_path: Path, toc_nodes: list[TocNode]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    same_file = input_path.resolve() == output_path.resolve()
    with fitz.open(input_path) as doc:
        toc_payload = [[node.level, node.title, node.page_index + 1] for node in toc_nodes]
        doc.set_toc(toc_payload)
        if same_file:
            temp_path = output_path.with_suffix(f"{output_path.suffix}.tmp")
            doc.save(temp_path)
            temp_path.replace(output_path)
        else:
            doc.save(output_path)
