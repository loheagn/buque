from __future__ import annotations

from pathlib import Path

import typer

from buque.core.pipeline import run_add_bookmarks

app = typer.Typer(help="Buque PDF bookmark generation CLI.", no_args_is_help=True)


@app.callback()
def main() -> None:
    """Top-level CLI command group."""


@app.command("add-bookmarks")
def add_bookmarks(
    input_path: Path = typer.Option(
        ...,
        "--input",
        help="Input PDF file path.",
        exists=True,
        file_okay=True,
        dir_okay=False,
        readable=True,
        resolve_path=True,
    ),
    output_path: Path = typer.Option(
        ...,
        "--output",
        help="Output PDF file path with bookmarks.",
        file_okay=True,
        dir_okay=False,
        writable=True,
        resolve_path=True,
    ),
    lang: str = typer.Option("zh", "--lang", help="Language hint passed to the OCR backend."),
    enable_ocr: bool = typer.Option(False, "--enable-ocr", help="Enable OCR routing for scanned or hybrid PDFs."),
    ocr_strategy: str | None = typer.Option(
        None,
        "--ocr-strategy",
        help="OCR strategy: toc-guided or full-page. Defaults to toc-guided.",
    ),
    enable_llm: bool = typer.Option(False, "--enable-llm", help="Reserved LLM switch for future stages."),
    report_path: Path = typer.Option(
        Path("report.json"),
        "--report",
        help="Path to output report json.",
        file_okay=True,
        dir_okay=False,
        resolve_path=True,
    ),
    toc_json_path: Path = typer.Option(
        Path("toc.json"),
        "--toc-json",
        help="Path to output toc json.",
        file_okay=True,
        dir_okay=False,
        resolve_path=True,
    ),
    config_path: Path | None = typer.Option(
        None,
        "--config",
        help="Optional YAML config path.",
        exists=True,
        file_okay=True,
        dir_okay=False,
        readable=True,
        resolve_path=True,
    ),
) -> None:
    result = run_add_bookmarks(
        input_path=input_path,
        output_path=output_path,
        report_path=report_path,
        toc_json_path=toc_json_path,
        lang=lang,
        enable_ocr=enable_ocr,
        enable_llm=enable_llm,
        config_path=config_path,
        ocr_strategy=ocr_strategy,
    )
    if result.success:
        typer.echo(result.message)
        return

    typer.echo(result.message, err=True)
    raise typer.Exit(code=result.exit_code)


if __name__ == "__main__":
    app()
