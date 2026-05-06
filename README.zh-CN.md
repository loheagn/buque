# Buque

Buque 是一个 PDF 书籍书签生成工具。当前版本聚焦 M1：为可提取文本的 PDF 自动识别标题，并写入 PDF Outlines，也就是大多数 PDF 阅读器侧边栏中显示的导航书签。

Buque 当前不会生成 PDF/UA 意义上的 Tagged PDF 结构标签。OCR、混合文档路由和 LLM 复核接口已有预留，但尚未实现。

## 功能

- 检测文本型 PDF，并在 M1 中拒绝尚不支持的扫描版或混合版 PDF。
- 通过 PyMuPDF 提取文本行、字号、字体名、加粗标记和页面坐标。
- 使用样式、位置、编号模式和语义关键词信号为标题候选打分。
- 从 `Chapter 1`、`第1章`、`第2节`、`1.2.3` 等章节模式推断书签层级。
- 构建去重后的目录，并提供简单的层级跳跃保护。
- 将书签写入新的 PDF 文件。
- 输出 `toc.json` 和 `report.json` 便于检查。

## 安装

本仓库使用 `uv`。

```bash
uv sync
```

在工作区中运行 CLI：

```bash
uv run buque --help
```

## 使用

```bash
uv run buque add-bookmarks \
  --input ./book.pdf \
  --output ./book.tagged.pdf \
  --report ./report.json \
  --toc-json ./toc.json
```

该命令会写出：

- `book.tagged.pdf`：带有生成书签的输出 PDF。
- `toc.json`：生成的书签节点。
- `report.json`：文档类型、候选数量、接受和拒绝数量、规则统计和错误信息。

## 当前范围

M1 只支持文本型 PDF。当 PDF 中有足够多页面包含可提取文本时，会被视为文本型 PDF。扫描版 PDF 和混合版 PDF 会以退出码 `2` 拒绝。

`--enable-ocr`、`--enable-llm` 和 `--lang` 参数是为后续阶段预留的。当前版本中传入这些参数不会启用 OCR 或 LLM 处理。

## 开发

运行测试：

```bash
uv run pytest
```

构建包产物：

```bash
uv build
```

## 项目结构

```text
buque/
  cli.py                  # Typer CLI
  core/
    classify.py           # 文本/扫描/混合文档分类
    extract_text.py       # 基于 PyMuPDF 的文本行提取
    candidate_rules.py    # 标题候选提取
    scorer.py             # 规则打分与层级推断
    tree_builder.py       # TOC 节点构建
    writer.py             # PDF 书签写入
  ocr/                    # OCR 占位接口
  llm/                    # LLM 占位接口
tests/
  test_cli_smoke.py
  test_scorer.py
  test_tree_builder.py
```

## 限制

- 还没有 OCR 路径，因此不支持扫描版 PDF。
- 还没有页面级路由，因此不支持混合版 PDF。
- 还没有 LLM 解析器、重试、schema 校验或缓存。
- 还没有基准数据集，也没有 precision/recall 评估工具。
- 复杂版式的真实书籍仍可能需要调规则。
