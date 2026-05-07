# Buque

Buque 是一个 PDF 书籍书签生成工具。它会为文本型、扫描版和混合版 PDF 自动识别标题，并写入 PDF Outlines，也就是大多数 PDF 阅读器侧边栏中显示的导航书签。

Buque 当前不会生成 PDF/UA 意义上的 Tagged PDF 结构标签。基于 OCR 的扫描页路由已实现。`--enable-llm` 仍为后续阶段预留，当前不会调用 LLM。

## 功能

- 检测文本型、扫描版和混合版 PDF。
- 通过 PDF.js 提取文本行、字号、字体名、加粗提示和页面坐标。
- 设置 `--enable-ocr` 后，将扫描页或混合文档中的稀疏文本页路由到 OCR 命令后端。
- 使用样式、位置、编号模式和语义关键词信号为标题候选打分。
- 从 `Chapter 1`、`第1章`、`第2节`、`Appendix A`、`1.2.3` 等章节模式推断书签层级。
- 构建去重后的目录，并提供简单的层级跳跃保护。
- 将书签写入新的 PDF 文件。
- 输出 `toc.json` 和 `report.json` 便于检查。

## 安装

本仓库使用 Node.js 和 npm。

```bash
npm install
npm run build
```

在工作区中运行 CLI：

```bash
npx buque --help
```

开发时也可以直接运行 TypeScript 源码：

```bash
npx tsx src/cli.ts --help
```

## 使用

```bash
npx buque add-bookmarks \
  --input ./book.pdf \
  --output ./book.bookmarked.pdf \
  --report ./report.json \
  --toc-json ./toc.json
```

该命令会写出：

- `book.bookmarked.pdf`：带有生成书签的输出 PDF。
- `toc.json`：生成的书签节点。
- `report.json`：文档类型、候选数量、接受和拒绝数量、规则统计和错误信息。

## OCR

扫描版和混合版 PDF 需要设置 `--enable-ocr` 并配置 OCR 命令。通过 `BUQUE_OCR_COMMAND` 指定命令；该命令接收图片路径和语言参数，并将 OCR 结果按行输出到 stdout：

```bash
BUQUE_OCR_COMMAND='my-ocr-command' \
npx buque add-bookmarks --enable-ocr --lang eng \
  --input ./scan.pdf \
  --output ./scan.bookmarked.pdf
```

如果命令需要自定义参数位置，可以使用 `{image}` 和 `{lang}` 占位符：

```bash
BUQUE_OCR_COMMAND='my-ocr-command --image {image} --lang {lang}'
```

对于影印版但带有噪声隐藏文本层的 PDF，可设置 `BUQUE_FORCE_OCR=1` 忽略提取文本并对每页执行 OCR。`BUQUE_OCR_RENDER_SCALE` 可调整 OCR 渲染分辨率；数值越大通常越慢，但可能提升准确率。

对于扫描书籍，OCR 默认使用 `toc-guided` 策略：先向前扫描到目录，解析目录页码，再只 OCR 目录指向的目标页以及少量前置/尾部窗口。如果 guided 路径无法生成书签，会自动回退到 full-page OCR：

```bash
BUQUE_FORCE_OCR=1 \
BUQUE_OCR_RENDER_SCALE=0.5 \
BUQUE_TOC_GUIDED_TOC_RENDER_SCALE=2.0 \
npx buque add-bookmarks --enable-ocr --lang ch \
  --input ./scan.pdf \
  --output ./scan.bookmarked.pdf
```

传入 `--ocr-strategy full-page` 可跳过 guided 路径，直接 OCR 所有路由页面。必要时可通过 `BUQUE_TOC_GUIDED_CONFIRM_WINDOW` 扩大每个推导页码附近的确认范围；默认值为 `0`。

OCR 默认串行执行。传入 `--ocr-parallelism N` 且 `N > 1` 时，会并发运行多个 OCR 命令进程。自定义进程内 OCR 后端会自动降级为串行执行。

PaddleOCR 不再作为进程内后端内置支持。如需使用 PaddleOCR，请封装成外部命令，并通过 `BUQUE_OCR_COMMAND` 接入。

## 开发

运行测试：

```bash
npm test
```

类型检查和构建：

```bash
npm run typecheck
npm run build
```

检查生产依赖许可证：

```bash
npm run check:licenses
```

## 项目结构

```text
src/
  cli.ts                  # Commander CLI
  core/
    classify.ts           # 文本/扫描/混合文档分类
    candidate-rules.ts    # 标题候选提取
    ocr-extract.ts        # OCR 页面渲染与候选转换
    pipeline.ts           # add-bookmarks 主流程
    scorer.ts             # 规则打分与层级推断
    toc-guided.ts         # 面向扫描书籍的目录引导 OCR 策略
    tree-builder.ts       # TOC 节点构建
    writer.ts             # PDF 书签写入
  ocr/
    command.ts            # OCR 命令后端
  pdf/
    document.ts           # PDF.js 文档适配层
test/
  pipeline.test.ts
  scorer.test.ts
  tree-builder.test.ts
```

## 许可证说明

项目源码继续使用 MIT 许可证。运行时 PDF 依赖均为 MIT 或 Apache-2.0：PDF.js (`pdfjs-dist`)、`canvas`、`pdf-lib` 和 `@lillallol/outline-pdf`。

项目有意不再使用 MuPDF.js/PyMuPDF，因为它们的开源分发是 AGPL/商业双许可。`npm run check:licenses` 会在 lockfile 中出现 AGPL/GPL/LGPL 依赖时失败。

## 限制

- 还没有 LLM 解析器、重试、schema 校验或缓存。
- 还没有基准数据集，也没有 precision/recall 评估工具。
- PDF.js 暴露的字体和坐标信息可能与 PyMuPDF 不完全一致，复杂版式的真实书籍仍可能需要调规则。
