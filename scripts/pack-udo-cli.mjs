/**
 * pack-udo-cli.mjs — 生成「解析组件独立包」，供轻量 Skill 安装时按需下载。
 *
 *   node scripts/pack-udo-cli.mjs
 *   → release/udo-cli-<version>-win64.zip
 *
 * 包内结构（解压到 App 根即可用）：
 *   bin/udo-cli/udo-cli.exe
 *   licenses/…（MPL-2.0 义务要求的随附附件）
 *
 * 说明：bin/udo-cli 与 crates/ 是闭源产物，不在 git 仓库里，只随 Release 分发；
 * 轻量 Skill 包要装上解析组件，只能从这里取。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { copyClosedSourceBinary } from "./skill-build-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "server/package.json"), "utf8"));
const VERSION = pkg.version;
const NAME = `udo-cli-${VERSION}-win64`;
const STAGE = path.join(ROOT, "release", NAME);
const ZIP = path.join(ROOT, "release", `${NAME}.zip`);

fs.rmSync(STAGE, { recursive: true, force: true });
fs.rmSync(ZIP, { force: true });
fs.mkdirSync(STAGE, { recursive: true });

const udo = copyClosedSourceBinary(STAGE);
if (!udo.included) {
  console.error(`跳过：${udo.reason}（本机没有闭源二进制，无法生成独立包）`);
  process.exit(1);
}

try {
  execFileSync("tar.exe", ["-a", "-c", "-f", ZIP, "-C", path.join(ROOT, "release"), NAME], {
    stdio: "inherit",
  });
} catch {
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${STAGE}' -DestinationPath '${ZIP}' -CompressionLevel Optimal`,
  ], { stdio: "inherit" });
}

const bytes = fs.statSync(ZIP).size;
const sha = crypto.createHash("sha256").update(fs.readFileSync(ZIP)).digest("hex");
console.log(`  udo-cli  ${udo.bytes} B + ${udo.licenses.length} 个许可附件`);
console.log(`  压缩包  ${(bytes / 1024 / 1024).toFixed(1)} MB  ${path.relative(ROOT, ZIP)}`);
console.log(`  SHA256  ${sha}`);
