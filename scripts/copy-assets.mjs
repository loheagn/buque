import { copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/configs/", import.meta.url), { recursive: true });
await copyFile(new URL("../src/configs/default.yaml", import.meta.url), new URL("../dist/configs/default.yaml", import.meta.url));
