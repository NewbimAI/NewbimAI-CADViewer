# 参与贡献

谢谢你有兴趣！提交 Pull Request 前请先读完这一页。

## 1. 先签 CLA（必须）

本项目以 **AGPL-3.0-only** 开源，同时对无法遵守 AGPL 义务的企业提供**商业许可**。
为了让同一份贡献能同时用于这两种授权，我们需要你对贡献授予**再许可权**——详见 [`CLA.md`](./CLA.md)。

- **个人**：首次提 PR 时，CLA 检查会在该 PR 里留言；在里面直接回复下面这句话（原样复制）即可：

  ```
  I have read the CLA Document and I hereby sign the CLA
  ```

  签完若状态未变，回复 `recheck` 重新检查。签名会自动记录到
  [`signatures/version1/cla.json`](./signatures/version1/cla.json)。
- **公司 / 组织**：由授权代表发邮件到 **nbimgpt@163.com**（标题 `CLA - <公司名>`）。

> ⚠️ 没有签署 CLA 的 PR 无法合并。这不是形式——没有它，我们就无法继续提供商业许可。

## 2. 每个 commit 都要有 DCO 签名

```bash
git commit -s -m "fix: 修复图层聚焦在重载期间被丢弃"
```

`-s` 会自动追加：

```
Signed-off-by: 你的名字 <you@example.com>
```

它表示你确认自己有权提交这段代码（https://developercertificate.org/）。CI 会检查。

## 3. 提交前自测

```bash
# 服务端：语法
node --check server/index.js

# 前端：类型检查 + 构建
cd web
npx tsc --noEmit -p tsconfig.json
npm run build
```

> ⚠️ **改了 `web/` 前端，必须 `npm run build` 并把 `web/dist` 一起提交。**
> 仓库分发预构建产物（`web/dist` 在 `.gitignore` 里被显式放行），
> 这样别人 `git clone` 后能直接起界面，不必花几分钟 `npm install` + 构建。
> 忘了提交 → `dist` 与源码漂移，别人看到的界面是旧的。

改动前请留意两个版本号（**不 bump 的话用户命中旧缓存，改动看不到**）：

| 改了什么 | 要动的版本号 | 位置 |
|---|---|---|
| 统计口径（`scanner.js` 输出字段） | `STATS_VERSION` | `server/index.js` |
| Web DXF 的产出内容（`dxf-web.js`） | `DXF_WEB_VERSION` | `server/dxf-web.js` |
| 转换/缓存的整体语义 | `CACHE_VERSION` | `server/index.js`（会重算所有缓存，慎用） |

## 4. 提交信息

`<type>: <summary>`，type 用 `feat` / `fix` / `perf` / `refactor` / `docs` / `chore` / `test`。

## 5. 不要提交这些

**本地图纸一律不提交。** 任何 `.dwg` / `.dxf` / `.dwf` 文件（不论放在哪个目录、大小写如何）都已在 `.gitignore` 里全局忽略；`data/`（用户上传的原图）同样整目录排除。除此之外 `.workbuddy/`、`.snapshots/`、`docs/`、`server/cache/`（纯派生缓存，可随时整目录删）、`test/*`、`bin/cadcraft/` 也都在忽略列表中。

提交前自检：

```bash
git status --short
git check-ignore -v <path>
# 暂存区里不应出现图纸文件（应无输出）
git diff --cached --name-only | grep -iE '\.(dwg|dxf|dwf)$'
```

## 6. 代码风格

- 与周边代码保持一致，不要顺手大改无关文件。
- 改 TSX 尽量整段替换，避免正则批改。
- 中文注释没问题；但**不要在代码或注释里写入任何未公开的商业计划或第三方软件逆向细节**。
