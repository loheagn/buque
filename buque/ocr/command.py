from __future__ import annotations

import os
import shlex
import subprocess
import tempfile


class CommandOCRBackend:
    """OCR backend that delegates page images to a user-provided command."""

    def __init__(self, command_template: str, *, timeout_seconds: int = 60) -> None:
        self.command_template = command_template
        self.timeout_seconds = timeout_seconds

    @classmethod
    def from_environment(cls) -> "CommandOCRBackend | None":
        command = os.environ.get("BUQUE_OCR_COMMAND", "").strip()
        if not command:
            return None
        return cls(command)

    def extract(self, *, page_image_bytes: bytes, lang: str) -> list[str]:
        with tempfile.NamedTemporaryFile(suffix=".png") as image_file:
            image_file.write(page_image_bytes)
            image_file.flush()
            command = self._build_command(image_path=image_file.name, lang=lang)
            completed = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=self.timeout_seconds,
            )

        if completed.returncode != 0:
            detail = completed.stderr.strip() or completed.stdout.strip() or "unknown OCR command failure"
            raise RuntimeError(f"OCR command failed with exit code {completed.returncode}: {detail}")

        return [line.strip() for line in completed.stdout.splitlines() if line.strip()]

    def _build_command(self, *, image_path: str, lang: str) -> list[str]:
        template = self.command_template
        if "{image}" in template or "{lang}" in template:
            template = template.format(image=shlex.quote(image_path), lang=shlex.quote(lang))
            return shlex.split(template)
        return [*shlex.split(template), image_path, lang]
