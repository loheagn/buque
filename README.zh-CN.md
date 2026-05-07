# Buque

Buque 是一个 PDF 书籍书签生成工具。当前版本聚焦 M2：为文本型、扫描版和混合版 PDF 自动识别标题，并写入 PDF Outlines，也就是大多数 PDF 阅读器侧边栏中显示的导航书签。

Buque 当前不会生成 PDF/UA 意义上的 Tagged PDF 结构标签。M2 已实现基于 OCR 的扫描页路由。LLM 复核接口仍为后续阶段预留，尚未实现。

## 功能

- 检测文本型、扫描版和混合版 PDF。
- 通过 PyMuPDF 提取文本行、字号、字体名、加粗标记和页面坐标。
- 设置 `--enable-ocr` 后，将扫描页或混合文档中的稀疏文本页路由到 OCR 后端。
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

### OCR

扫描版和混合版 PDF 需要设置 `--enable-ocr` 并配置 OCR 后端。CLI 使用时，通过 `BUQUE_OCR_COMMAND` 指定命令；该命令接收图片路径和语言参数，并将 OCR 结果按行输出到 stdout：

```bash
BUQUE_OCR_COMMAND='my-ocr-command' \
uv run buque add-bookmarks --enable-ocr --lang eng \
  --input ./scan.pdf \
  --output ./scan.bookmarked.pdf
```

如果命令需要自定义参数位置，可以使用 `{image}` 和 `{lang}` 占位符：

```bash
BUQUE_OCR_COMMAND='my-ocr-command --image {image} --lang {lang}'
```

如果当前 Python 环境已经安装 PaddleOCR，Buque 可以在进程内直接使用它：

```bash
BUQUE_OCR_BACKEND=paddleocr \
BUQUE_PADDLE_OCR_VERSION=PP-OCRv5 \
uv run buque add-bookmarks --enable-ocr --lang ch \
  --input ./scan.pdf \
  --output ./scan.bookmarked.pdf
```

对于影印版但带有噪声隐藏文本层的 PDF，可设置 `BUQUE_FORCE_OCR=1` 忽略提取文本并对每页执行 OCR。`BUQUE_OCR_RENDER_SCALE` 可调整 OCR 渲染分辨率；数值越大通常越慢，但可能提升准确率。

## 当前范围

M2 可直接处理文本型 PDF。当 PDF 中有足够多页面包含可提取文本时，会被视为文本型 PDF。扫描版 PDF 和混合版 PDF 中的稀疏文本页会在设置 `--enable-ocr` 且配置 OCR 后端后通过 OCR 处理；否则会以退出码 `2` 拒绝。

`--enable-llm` 参数是为后续阶段预留的。当前版本中传入该参数只会在报告中记录 LLM 降级状态，不会调用 LLM。

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
    ocr_extract.py        # OCR 页面渲染与候选转换
    candidate_rules.py    # 标题候选提取
    scorer.py             # 规则打分与层级推断
    tree_builder.py       # TOC 节点构建
    writer.py             # PDF 书签写入
  ocr/                    # OCR 接口与命令行后端
  llm/                    # LLM 占位接口
tests/
  test_cli_smoke.py
  test_scorer.py
  test_tree_builder.py
```

## 限制

- 还没有 LLM 解析器、重试、schema 校验或缓存。
- 还没有基准数据集，也没有 precision/recall 评估工具。
- 复杂版式的真实书籍仍可能需要调规则。
