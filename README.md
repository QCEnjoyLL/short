# short

一个部署在 Cloudflare Pages + D1 上的轻量短链接服务。保留原项目简洁的页面，不引入额外框架、KV 或管理后台。

## 这版改了什么

- 所有数据库输入使用参数绑定，避免 SQL 注入和单引号导致的错误。
- 默认创建短链必须携带 `CREATE_TOKEN`；可通过 `PUBLIC_CREATE=true` 显式开启免密码公开创建，已有短链始终可公开访问。
- 为短链后缀添加唯一索引，为目标网址添加查询索引；并发占用同一后缀不会覆盖记录。
- 使用加密安全的 6 位随机后缀，碰撞最多重试 5 次；自定义后缀支持 2–32 位字母、数字、`_`、`-`。
- 修复重复提交同一自定义短链报错的问题；冲突返回 HTTP 409。
- 增加输入、请求大小、HTTP 方法检查，异常不向客户端暴露数据库细节。
- 默认关闭访问日志，避免每次跳转消耗写入额度；需要时可显式开启，日志失败不影响跳转。
- 首页及静态资源不执行 Functions；构建仅发布公开资源，避免把 SQL、测试和本地密码文件上传为静态文件。
- 保留原页面样式，补充密码输入、独立结果框、回车提交、复制降级和错误提示。

## Cloudflare Pages 部署

1. 将代码推送到你自己的 Git 仓库，连接到 Cloudflare Pages。
2. 构建设置：框架预设 `None`，构建命令 **`npm run build`**，输出目录 **`dist`**，项目根目录为本仓库根目录。建议设置构建变量 `NODE_VERSION=24`。
3. 新建或选择原有 D1 数据库，在 Pages 设置中添加 D1 绑定，变量名必须是 **`DB`**。
4. 新数据库：在 D1 控制台执行本仓库 `short.sql` 的内容。已有数据库：先按下一节检查，再执行；不要使用旧版 README 中包含 `DROP TABLE` 的初始化 SQL。
5. 默认密码模式：在 Pages 的变量和机密设置中添加 **Secret `CREATE_TOKEN`**，使用较长的随机密码（建议至少 32 位）。不要提交到 Git，也不要放在前端代码中。免密码模式见下一节。
6. 可选添加普通变量 `LOG_VISITS=true` 开启日志；不配置或设为 `false` 时不记录访问日志。
7. 生产和预览环境的绑定、Secret 分别配置，完成后重新部署。
8. 打开首页，密码模式下展开“自定义设置”输入创建密码；公开模式可直接生成。短链跳转不需要密码。应用不将密码写入 localStorage、sessionStorage 或 Cookie。

**如果从原版升级，必须把原来的输出目录从仓库根目录改为 `dist`，并设置构建命令。**

## 随时切换是否需要创建密码

在 Pages 项目的 **Settings → Variables and Secrets** 中添加普通文本变量 `PUBLIC_CREATE`：

| `PUBLIC_CREATE` 的值 | 创建行为 |
| --- | --- |
| `true` | 公开创建，不需要密码；网页中的密码框可留空 |
| `false` 或未设置 | 需要正确的 `CREATE_TOKEN`；缺少该 Secret 时禁止创建 |

只有精确的小写字符串 `true` 会开启公开创建，其他值（例如 `TRUE`、`1`、空值）均保持密码保护。

每次修改后保存并重新部署，新的部署才会采用新设置；它不是立即作用于已有部署的实时开关。生产和预览环境分别配置。

建议始终保留 `CREATE_TOKEN` Secret：公开模式下它不参与鉴权，将 `PUBLIC_CREATE` 改回 `false` 并重新部署即可恢复密码保护，无需改代码或重新初始化数据库。若曾删除 Secret，恢复密码模式前需要重新添加。

公开模式会允许任何人通过本站或 API 创建短链并消耗额度；不开放跨站浏览器 CORS，但这不能阻止直接调用 API。需要时另行配置 Cloudflare 限流或访问规则。

## 已有数据安全升级

先在 Cloudflare D1 控制台导出备份，然后检查是否有重复后缀：

```sql
SELECT slug, COUNT(*) AS count
FROM links
GROUP BY slug
HAVING COUNT(*) > 1;
```

- 无重复：执行当前 `short.sql`。它只创建不存在的表和索引，**不会清空已有链接和日志**，可以重复执行。
- 有重复：先人工核对冲突记录、确定保留哪条，再创建唯一索引。脚本会拒绝创建冲突索引，**不会自动删除或覆盖记录**。
- 旧的 4 位后缀和非英文后缀仍可跳转，新建后缀才受新格式限制。
- `status=1` 的记录正常跳转，其他状态返回 404。原版创建的正常链接状态就是 `1`。
- 访问日志默认关闭，但不会删除旧日志。备份后可按需人工清理。

## 本地开发

需要 Node.js 24 或更高版本。

```bash
npm ci --registry=https://registry.npmjs.org
```

将 `.dev.vars.example` 复制为 `.dev.vars`，替换其中的 `CREATE_TOKEN`。该文件已加入 Git 忽略列表。

```bash
npm run d1
npm run dev
```

`npm run d1` 仅初始化本地模拟数据库，`npm run dev` 默认启动在 `http://localhost:8788`。本地配置 `wrangler.local.jsonc` 中的数据库标识仅用于模拟，不是线上数据库 ID；线上配置仍在 Pages 控制台管理。

如果 Windows 本地运行遇到 `miniflare-email-store` 的临时目录拒绝访问错误，可以在当前 PowerShell 会话设置工作区临时目录后重试（不修改系统设置）：

```powershell
New-Item -ItemType Directory -Force .wrangler/tmp | Out-Null
$env:TEMP = (Resolve-Path .wrangler/tmp).Path
$env:TMP = $env:TEMP
npm run d1
npm run dev
```

修改 HTML 或静态资源后重新执行 `npm run build`，或者重启 `npm run dev`。

## API

支持同源网页调用，或服务端 / 命令行调用；不开放通配 CORS。密码模式需要 Bearer Token，公开模式可以省略 `Authorization` 请求头。

```bash
curl -X POST 'https://你的域名/create' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer 你的创建密码' \
  -d '{"url":"https://example.com/article","slug":"my-link"}'
```

`slug` 可省略。成功示例：

```json
{
  "slug": "my-link",
  "link": "https://你的域名/my-link"
}
```

- 相同网址未指定后缀时，复用已有可用短链；同一网址允许创建不同的自定义后缀。
- 同一自定义后缀和网址重复提交时，返回已有链接；后缀指向其他网址时返回 `409`。
- 错误码：`400` 输入错误，`401` 密码错误，`403` 跨站调用，`405` 方法不支持，`413` 请求超过 16 KiB，`415` 非 JSON，`503` 配置、数据库或服务异常。
- 目标仅允许无内嵌账号密码的 HTTP(S) 网址，最长 8192 字符；不允许缩短当前站点域名。
- 短链使用 `302` 跳转；支持 `GET` 和 `HEAD`，后者不写访问日志。

## 日志与维护

仅当 `LOG_VISITS` 精确设置为字符串 `true` 时，每次有效 GET 跳转才写一条日志，包含目标网址、后缀、IP、Referer、User-Agent 和 UTC 时间。日志在响应后异步写入，不提供可视化统计后台，也不自动清理。

建议自用保持关闭。开启时需要考虑隐私与容量，定期备份、清理；新版时间使用 ISO 8601 格式，旧版中文时间格式需要单独核对，不能直接混用日期清理条件。

创建密码不是限流器。不要使用弱密码；如开放给多人使用，建议在 Cloudflare 为 `/create` 额外配置适合自身套餐的限流或访问规则。D1 与 Pages Functions 的免费额度仍分别适用。

## 验证

```bash
npm test
npm run check
```

测试使用 Node 内置测试框架和内存 SQLite，无需真实 Cloudflare 账户。覆盖鉴权、SQL 注入输入、重复和并发创建、随机碰撞、输入错误、索引使用、旧数据保留、日志失败、前端请求与复制降级。`npm run check` 另外检查静态构建和 Pages Functions 打包。

本项目不会自动部署、迁移线上数据库或修改你的 Cloudflare 账户。

## 许可

本项目采用 MIT 许可，详见 [LICENSE](LICENSE)。
