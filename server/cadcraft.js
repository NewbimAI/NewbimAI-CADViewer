import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";

const execFileAsync = promisify(execFile);

/** 浅层递归查找文件（不依赖实验性 glob API） */
function findFiles(dir, pattern, maxDepth = 2, depth = 0) {
  const results = [];
  if (depth > maxDepth) return results;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && pattern.test(e.name)) results.push(full);
    else if (e.isDirectory() && e.name !== "fonts") {
      results.push(...findFiles(full, pattern, maxDepth, depth + 1));
    }
  }
  return results;
}

/**
 * 在项目 bin/ 目录下定位 cadcraft-cli.exe
 * 兼容多种解压布局（bin 下多级子目录）
 */
export function resolveCliPath(projectRoot) {
  const binDir = path.join(projectRoot, "bin");
  if (!fs.existsSync(binDir)) return null;

  const found = findFiles(binDir, /^cadcraft-cli[\w.-]*\.exe$/i);
  if (found.length > 0) return found[0];

  // portable zip 可能只带主程序 cadcraft.exe，它同样支持 CLI 子命令
  const main = findFiles(binDir, /^cadcraft[\w.-]*\.exe$/i);
  if (main.length > 0) return main[0];

  return null;
}

export class CadcraftCli {
  constructor(cliPath) {
    this.cliPath = cliPath;
  }

  async run(args, { timeoutMs = 120000 } = {}) {
    const { stdout, stderr } = await execFileAsync(this.cliPath, args, {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr };
  }

  /** 图纸概要信息（cadcraft-cli info <file>），返回解析后的 JSON（失败返回 null） */
  async infoJson(absPath) {
    try {
      const { stdout } = await this.run(["info", absPath]);
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  }

  /** 转换为 SVG。window 存在时用 --window 裁剪飞点后的主体范围 */
  async convertToSvg(absPath, outSvgPath, window = null) {
    const args = ["convert", absPath, outSvgPath];
    if (window) {
      args.push(
        "--window",
        `${window.minX},${window.minY},${window.maxX},${window.maxY}`
      );
    }
    const { stdout, stderr } = await this.run(args);
    if (!fs.existsSync(outSvgPath) || fs.statSync(outSvgPath).size === 0) {
      throw new Error(
        `SVG 转换失败: ${stderr || stdout || "cadcraft-cli 未产出文件"}`
      );
    }
    return outSvgPath;
  }

  /** DWG → DXF（convert 直出，用于精确统计） */
  async toDxf(absPath, outDxfPath) {
    try {
      await this.run(["convert", absPath, outDxfPath]);
      if (fs.existsSync(outDxfPath) && fs.statSync(outDxfPath).size > 0) {
        return outDxfPath;
      }
    } catch {
      /* convert 不支持时退回 run --save */
    }
    try {
      await this.run(["run", absPath, "--save", outDxfPath]);
      if (fs.existsSync(outDxfPath) && fs.statSync(outDxfPath).size > 0) {
        return outDxfPath;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  async version() {
    try {
      const { stdout } = await this.run(["--version"]);
      return stdout.trim();
    } catch (err) {
      return err.stdout?.trim() || null;
    }
  }
}
